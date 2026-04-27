const { PassThrough } = require("stream");
const { VoiceActivityDetector } = require("realtime-vad");

function createVADHandler(options = {}) {
  const speechThreshold = Number(process.env.VAD_SPEECH_THRESHOLD || 0.42);
  const silenceDebounceMs = Number(process.env.VAD_SILENCE_DEBOUNCE_MS || 220);
  const detector = new VoiceActivityDetector({
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    frameDurationMs: 30,
    speechThreshold: Number.isFinite(speechThreshold) ? speechThreshold : 0.42,
    silenceDebounceMs: Number.isFinite(silenceDebounceMs) ? silenceDebounceMs : 220
  });

  const pcmStream = new PassThrough();
  const bytesPerFrame = detector.chunkBytes;
  let pending = Buffer.alloc(0);
  let processingChain = Promise.resolve();
  let initialized = false;

  detector.on("speechStart", (startTs) => {
    console.log(`[VAD] speechStart at ${new Date(startTs).toISOString()}`);
    if (typeof options.onSpeechStart === "function") {
      options.onSpeechStart(startTs);
    }
  });

  detector.on("speechEnd", ({ duration }) => {
    console.log(`[VAD] speechEnd after ${duration}ms`);
    if (typeof options.onSpeechEnd === "function") {
      options.onSpeechEnd({ duration });
    }
  });

  async function processPendingFrames() {
    while (pending.length >= bytesPerFrame) {
      const frame = pending.subarray(0, bytesPerFrame);
      pending = pending.subarray(bytesPerFrame);
      await detector.processAudioChunk(frame);
    }
  }

  async function start() {
    if (initialized) return;
    await detector.init();
    initialized = true;
    console.log("VAD initialized.");
  }

  function pushPCMChunk(chunk) {
    if (!chunk || chunk.length === 0) return;
    pcmStream.write(chunk);
    if (typeof options.onPCMChunk === "function") {
      options.onPCMChunk(chunk);
    }
    pending = Buffer.concat([pending, chunk]);

    // Serialize inference to keep VAD state consistent.
    processingChain = processingChain
      .then(async () => {
        if (!initialized) {
          await start();
        }
        await processPendingFrames();
      })
      .catch((error) => {
        console.error("VAD processing error:", error);
      });
  }

  function stop() {
    pcmStream.end();
    console.log("VAD stopped.");
  }

  return {
    start,
    stop,
    pushPCMChunk,
    getPCMStream() {
      return pcmStream;
    }
  };
}

module.exports = { createVADHandler };
