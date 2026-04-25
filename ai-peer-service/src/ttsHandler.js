const axios = require("axios");
const { getAxiosAgents } = require("./httpAgents");

/** OpenAI `audio/speech` voices (see OpenAI docs; list may grow). */
const OPENAI_TTS_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse"
]);

function normalizeTtsVoice(raw) {
  const v = String(raw ?? "nova")
    .trim()
    .toLowerCase();
  if (!v) {
    return "nova";
  }
  if (!OPENAI_TTS_VOICES.has(v)) {
    console.warn(
      `[TTS] Unknown voice "${raw}". Using "nova". Valid voices: ${[...OPENAI_TTS_VOICES].sort().join(", ")}`
    );
    return "nova";
  }
  return v;
}

function normalizeTtsModel(raw) {
  const m = String(raw ?? "tts-1")
    .trim()
    .toLowerCase();
  if (m === "tts-1") {
    return m;
  }
  console.warn(`[TTS] Unknown model "${raw}". Using "tts-1".`);
  return "tts-1";
}

function normalizeTtsSpeed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return 1.1;
  }
  return Math.min(4.0, Math.max(0.25, n));
}

const FILLER_PHRASES = ["Let me think...", "I'm not sure."];
const SENTENCE_BOUNDARY = /[.!?]\s*$|\n$/;
const PHRASE_BOUNDARY = /[.!?,;:]\s*$|\n$/;
const TTS_PCM_SAMPLE_RATE = 24000;
const OPUS_PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 1;
const PCM_SAMPLE_SIZE_BYTES = 2;
const TTS_PCM_FRAME_SAMPLES = 480; // 20ms @ 24kHz
const TTS_PCM_FRAME_SIZE = TTS_PCM_FRAME_SAMPLES * PCM_CHANNELS * PCM_SAMPLE_SIZE_BYTES;
const OPUS_PCM_FRAME_SAMPLES = 960; // 20ms @ 48kHz
const OPUS_PCM_FRAME_SIZE = OPUS_PCM_FRAME_SAMPLES * PCM_CHANNELS * PCM_SAMPLE_SIZE_BYTES;

function createOpusEncoder() {
  try {
    const { OpusEncoder } = require("@discordjs/opus");
    const encoder = new OpusEncoder(OPUS_PCM_SAMPLE_RATE, PCM_CHANNELS);
    console.log("[TTS] Opus encoder backend: @discordjs/opus (native)");
    return encoder;
  } catch (discordOpusError) {
    try {
      const NodeOpus = require("node-opus");
      const encoder = new NodeOpus.OpusEncoder(OPUS_PCM_SAMPLE_RATE, PCM_CHANNELS);
      console.log("[TTS] Opus encoder backend: node-opus (native)");
      return encoder;
    } catch (nodeOpusError) {
      try {
        const OpusScript = require("opusscript");
        console.warn("[TTS] Opus encoder backend: opusscript (JS fallback)");
        return new OpusScript(OPUS_PCM_SAMPLE_RATE, PCM_CHANNELS, OpusScript.Application.AUDIO);
      } catch (opusScriptError) {
        console.error("Failed to load Opus encoder (@discordjs/opus, node-opus, opusscript):", {
          discordOpusError,
          nodeOpusError,
          opusScriptError
        });
        throw opusScriptError;
      }
    }
  }
}

function encodePcmFrame(encoder, pcmFrame) {
  if (typeof encoder.setBitrate === "function") {
    return Buffer.from(encoder.encode(pcmFrame, OPUS_PCM_FRAME_SAMPLES));
  }
  const encoded = encoder.encode(pcmFrame, OPUS_PCM_FRAME_SAMPLES);
  if (Buffer.isBuffer(encoded)) {
    return encoded;
  }
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

function upsample24kTo48kLinear(pcm24kMono) {
  if (!pcm24kMono || pcm24kMono.length < 4) {
    return Buffer.alloc(0);
  }

  const inSamples = Math.floor(pcm24kMono.length / 2);
  const outSamples = inSamples * 2;
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < inSamples - 1; i += 1) {
    const s0 = pcm24kMono.readInt16LE(i * 2);
    const s1 = pcm24kMono.readInt16LE((i + 1) * 2);
    const base = i * 2;
    out.writeInt16LE(s0, base * 2);
    out.writeInt16LE(Math.round((s0 + s1) / 2), (base + 1) * 2);
  }

  const last = pcm24kMono.readInt16LE((inSamples - 1) * 2);
  out.writeInt16LE(last, (outSamples - 2) * 2);
  out.writeInt16LE(last, (outSamples - 1) * 2);
  return out;
}

function createTTSHandler(options = {}) {
  const axiosAgents = getAxiosAgents();
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

  const voice = normalizeTtsVoice(
    options.voice ?? process.env.TTS_VOICE ?? process.env.OPENAI_TTS_VOICE ?? "nova"
  );
  const model = normalizeTtsModel(options.model ?? process.env.TTS_MODEL ?? "tts-1");
  const speed = normalizeTtsSpeed(
    options.speed ?? process.env.TTS_SPEED ?? 1.1
  );

  console.log(`[TTS] Using voice="${voice}" model="${model}" speed=${speed}`);

  const pushOpusFrame =
    options.pushOpusFrame ||
    (() => {
      return false;
    });

  /** @type {Map<string, { accumulated: string, emittedChars: number, queue: Promise<void>, encoder: any, generation: number, activeRequestController: AbortController | null }>} */
  const sessions = new Map();

  /** @type {Map<string, Buffer[]>} */
  const fillerCache = new Map();

  function getFillerCacheKey(phrase) {
    return `${voice}:${phrase}`;
  }

  function getSession(sessionId = "default") {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        accumulated: "",
        emittedChars: 0,
        queue: Promise.resolve(),
        encoder: createOpusEncoder(),
        generation: 0,
        activeRequestController: null
      });
    }
    return sessions.get(sessionId);
  }

  function queueWork(sessionId, task) {
    const session = getSession(sessionId);
    const queuedGeneration = session.generation;
    session.queue = session.queue
      .then(async () => {
        if (queuedGeneration !== session.generation) {
          return;
        }
        await task();
      })
      .catch((error) => {
        console.error(`[TTS ${sessionId}] queued work failed:`, error);
      });
    return session.queue;
  }

  function sentenceReady(text) {
    return SENTENCE_BOUNDARY.test(text);
  }

  function phraseReady(text) {
    return PHRASE_BOUNDARY.test(text);
  }

  function shouldEmitPendingText({ pending, emittedChars }) {
    const trimmed = pending.trim();
    if (!trimmed) {
      return false;
    }

    const MIN_FIRST_EMIT_CHARS = 8;
    const MIN_SUBSEQUENT_CHARS = 16;
    const MAX_PENDING_CHARS = 120;

    if (sentenceReady(pending) || phraseReady(pending)) {
      return emittedChars === 0 ? trimmed.length >= MIN_FIRST_EMIT_CHARS : true;
    }

    if (pending.length >= MAX_PENDING_CHARS) {
      return true;
    }

    if (emittedChars === 0) {
      return pending.length >= MIN_FIRST_EMIT_CHARS;
    }

    return pending.length >= MIN_SUBSEQUENT_CHARS;
  }

  async function synthesizeToOpusFrames(sessionId, text, signal, onFrame) {
    if (!apiKey || !text?.trim()) {
      return [];
    }

    const response = await axios.post(
      "https://api.openai.com/v1/audio/speech",
      {
        model,
        input: text,
        voice,   
        response_format: "pcm",
        speed
      },
      {
        responseType: "stream",
        signal,
        ...axiosAgents,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    const session = getSession(sessionId);
    let pcm24Remainder = Buffer.alloc(0);
    let pcm48Remainder = Buffer.alloc(0);
    const frames = [];

    function emitFrom48kBuffer() {
      while (pcm48Remainder.length >= OPUS_PCM_FRAME_SIZE) {
        const pcmFrame = pcm48Remainder.subarray(0, OPUS_PCM_FRAME_SIZE);
        pcm48Remainder = pcm48Remainder.subarray(OPUS_PCM_FRAME_SIZE);
        const opusFrame = encodePcmFrame(session.encoder, pcmFrame);
        if (typeof onFrame === "function") {
          onFrame(opusFrame);
        } else {
          frames.push(opusFrame);
        }
      }
    }

    await new Promise((resolve, reject) => {
      response.data.on("data", (chunk) => {
        pcm24Remainder = Buffer.concat([pcm24Remainder, chunk]);

        while (pcm24Remainder.length >= TTS_PCM_FRAME_SIZE) {
          const pcm24Frame = pcm24Remainder.subarray(0, TTS_PCM_FRAME_SIZE);
          pcm24Remainder = pcm24Remainder.subarray(TTS_PCM_FRAME_SIZE);
          const pcm48Chunk = upsample24kTo48kLinear(pcm24Frame);
          if (!pcm48Chunk.length) {
            continue;
          }
          pcm48Remainder = Buffer.concat([pcm48Remainder, pcm48Chunk]);
          emitFrom48kBuffer();
        }
      });

      response.data.on("end", resolve);
      response.data.on("error", reject);
    });

    if (pcm24Remainder.length > 0) {
      const pcm48Tail = upsample24kTo48kLinear(pcm24Remainder);
      if (pcm48Tail.length > 0) {
        pcm48Remainder = Buffer.concat([pcm48Remainder, pcm48Tail]);
      }
    }

    if (pcm48Remainder.length > 0) {
      const padded = Buffer.alloc(Math.ceil(pcm48Remainder.length / OPUS_PCM_FRAME_SIZE) * OPUS_PCM_FRAME_SIZE);
      pcm48Remainder.copy(padded, 0, 0, pcm48Remainder.length);
      pcm48Remainder = padded;
      emitFrom48kBuffer();
    }

    return frames;
  }

  async function synthesizeAndPushFrames(sessionId, text, signal) {
    if (!text?.trim()) {
      return;
    }
    await synthesizeToOpusFrames(sessionId, text, signal, (opusFrame) => {
      pushOpusFrame(opusFrame, sessionId);
    });
  }

  async function sendFrames(sessionId, frames) {
    if (!frames || frames.length === 0) {
      return;
    }
    for (const frame of frames) {
      pushOpusFrame(frame, sessionId);
    }
  }

  async function warmFillerCache() {
    for (const phrase of FILLER_PHRASES) {
      const cacheKey = getFillerCacheKey(phrase);
      if (fillerCache.has(cacheKey)) {
        continue;
      }
      try {
        const frames = await synthesizeToOpusFrames("filler-cache", phrase);
        fillerCache.set(cacheKey, frames);
      } catch (error) {
        console.warn(`Failed to pre-synthesize filler phrase "${phrase}":`, error);
      }
    }
  }

  async function maybeSpeakBufferedText(sessionId) {
    const session = getSession(sessionId);
    const pending = session.accumulated.slice(session.emittedChars);
    if (!pending.trim()) {
      return;
    }

    if (!shouldEmitPendingText({ pending, emittedChars: session.emittedChars })) {
      return;
    }

    const generationAtStart = session.generation;
    const controller = new AbortController();
    session.activeRequestController = controller;
    try {
      await synthesizeAndPushFrames(sessionId, pending, controller.signal);
      if (generationAtStart !== session.generation) {
        return;
      }
      session.emittedChars = session.accumulated.length;
    } finally {
      if (session.activeRequestController === controller) {
        session.activeRequestController = null;
      }
    }
  }

  function enqueuePhrase(sessionId, phrase) {
    return queueWork(sessionId, async () => {
      const cacheKey = getFillerCacheKey(phrase);
      const cachedFrames = fillerCache.get(cacheKey);
      if (cachedFrames) {
        await sendFrames(sessionId, cachedFrames);
        return;
      }
      const frames = await synthesizeToOpusFrames(sessionId, phrase);
      fillerCache.set(cacheKey, frames);
      await sendFrames(sessionId, frames);
    });
  }

  void warmFillerCache();

  async function drainSession(sessionId = "default") {
    return queueWork(sessionId, async () => {});
  }

  return {
    drainSession,
    async synthesizeStream(sessionIdOrToken, maybeToken) {
      const usingLegacySignature = typeof maybeToken !== "string";
      const sessionId = usingLegacySignature ? "default" : sessionIdOrToken || "default";
      const token = usingLegacySignature ? sessionIdOrToken : maybeToken;
      if (!token) {
        return;
      }

      const session = getSession(sessionId);
      session.accumulated += token;
      return queueWork(sessionId, async () => {
        await maybeSpeakBufferedText(sessionId);
      });
    },
    async flushSession(sessionId = "default") {
      return queueWork(sessionId, async () => {
        const session = getSession(sessionId);
        const pending = session.accumulated.slice(session.emittedChars);
        if (!pending.trim()) {
          return;
        }
        const generationAtStart = session.generation;
        const controller = new AbortController();
        session.activeRequestController = controller;
        await synthesizeAndPushFrames(sessionId, pending, controller.signal);
        if (session.activeRequestController === controller) {
          session.activeRequestController = null;
        }
        if (generationAtStart !== session.generation) {
          return;
        }
        session.emittedChars = session.accumulated.length;
      });
    },
    async speakFiller(sessionId = "default", phrase = FILLER_PHRASES[0]) {
      return enqueuePhrase(sessionId, phrase);
    },
    resetSession(sessionId = "default") {
      sessions.delete(sessionId);
    },
    abortSession(sessionId = "default") {
      const session = getSession(sessionId);
      session.generation += 1;
      if (session.activeRequestController) {
        session.activeRequestController.abort();
        session.activeRequestController = null;
      }
      session.accumulated = "";
      session.emittedChars = 0;
      session.queue = Promise.resolve();
    }
  };
}

module.exports = { createTTSHandler };