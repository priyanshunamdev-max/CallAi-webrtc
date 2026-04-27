require("dotenv").config({ override: true });

const { createSignalingClient } = require("./signalingClient");
const { createWebRTCPeer } = require("./webrtcPeer");
const { createVADHandler } = require("./vadHandler");
const { createSTTHandler } = require("./sttHandler");
const { createLLMHandler } = require("./llmHandler");
const { createTTSHandler } = require("./ttsHandler");
const ORCHESTRATOR_STATES = Object.freeze({
  LISTENING: "LISTENING",
  THINKING: "THINKING",
  SPEAKING: "SPEAKING"
});

const MIN_USER_SEGMENT_MS = Number(process.env.MIN_USER_SEGMENT_MS || 240);
const USER_TURN_FINALIZE_SILENCE_MS = Number(
  process.env.USER_TURN_FINALIZE_SILENCE_MS || 450
);
const USER_STT_TIMEOUT_MS = Number(process.env.USER_STT_TIMEOUT_MS || 7000);
const BARGE_IN_RMS_THRESHOLD = Number(process.env.BARGE_IN_RMS_THRESHOLD || 1400);
const BARGE_IN_MIN_CONSECUTIVE_CHUNKS = Number(
  process.env.BARGE_IN_MIN_CONSECUTIVE_CHUNKS || 3
);
const ASSISTANT_SPEECH_GRACE_MS = Number(
  process.env.ASSISTANT_SPEECH_GRACE_MS || 220
);
const ECHO_GUARD_WINDOW_MS = Number(process.env.ECHO_GUARD_WINDOW_MS || 2800);

async function bootstrap() {
  const signalingClient = createSignalingClient({
    serverUrl: process.env.SIGNALING_SERVER_URL,
    aiUserId: process.env.AI_USER_ID || "ai_assistant"
  });

  let orchestratorState = ORCHESTRATOR_STATES.LISTENING;
  let activeSessionId = "default";
  let isCollectingUserSpeech = false;
  /** @type {Buffer[]} */
  let userSpeechChunks = [];
  /** @type {Buffer[]} */
  let pendingUserTurnChunks = [];
  let pendingUserTurnDurationMs = 0;
  let userTurnFinalizeTimer = null;
  let userTurnFlow = Promise.resolve();
  let bargeInSpeechStreak = 0;
  let lastAssistantSpeakStartAt = 0;
  let lastAssistantSpeakEndAt = 0;
  let activeTurnId = 0;

  let stt;
  let llm;
  let tts;
  let peer;

  function beginNewTurn() {
    activeTurnId += 1;
    return activeTurnId;
  }

  function setState(nextState, reason) {
    if (orchestratorState === nextState) {
      return;
    }
    const previous = orchestratorState;
    orchestratorState = nextState;
    console.log(`[ORCHESTRATOR] ${previous} -> ${nextState}${reason ? ` (${reason})` : ""}`);
  }

  async function withTimeout(promise, ms, label) {
    let timeoutId;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
          }, ms);
        })
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async function processUserSpeech(audioSegment, durationMs) {
    if (!audioSegment?.length || durationMs < MIN_USER_SEGMENT_MS) {
      setState(ORCHESTRATOR_STATES.LISTENING, "speech too short");
      return;
    }

    const sessionId = activeSessionId || "default";
    const turnId = beginNewTurn();
    setState(
      ORCHESTRATOR_STATES.THINKING,
      `transcribing user speech (${durationMs}ms)`
    );
    const transcript = await withTimeout(
      stt.transcribeChunk(audioSegment),
      USER_STT_TIMEOUT_MS,
      "user STT"
    );

    if (!transcript?.trim()) {
      setState(ORCHESTRATOR_STATES.LISTENING, "empty transcript");
      return;
    }
    if (shouldIgnoreLikelyAssistantEcho(sessionId, transcript)) {
      console.log(`[ORCHESTRATOR] dropped likely echo transcript: ${transcript}`);
      setState(ORCHESTRATOR_STATES.LISTENING, "likely assistant echo");
      return;
    }

    console.log(`[ORCHESTRATOR] user transcript: ${transcript}`);
    await llm.handleUserTranscript(sessionId, transcript, tts, turnId);
  }

  function normalizeForSimilarity(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenOverlapRatio(a, b) {
    const aTokens = new Set(normalizeForSimilarity(a).split(" ").filter(Boolean));
    const bTokens = new Set(normalizeForSimilarity(b).split(" ").filter(Boolean));
    if (aTokens.size === 0 || bTokens.size === 0) {
      return 0;
    }
    let overlap = 0;
    for (const t of aTokens) {
      if (bTokens.has(t)) {
        overlap += 1;
      }
    }
    return overlap / Math.min(aTokens.size, bTokens.size);
  }

  function shouldIgnoreLikelyAssistantEcho(sessionId, transcript) {
    const withinEchoWindow = Date.now() - lastAssistantSpeakEndAt <= ECHO_GUARD_WINDOW_MS;
    if (!withinEchoWindow) {
      return false;
    }
    const context = llm?.getContext?.(sessionId) || [];
    if (context.length === 0) {
      return false;
    }
    const lastAssistant = [...context].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant?.content) {
      return false;
    }
    const overlap = tokenOverlapRatio(transcript, lastAssistant.content);
    return overlap >= 0.6;
  }

  function interruptAssistantForUserSpeech(reason) {
    if (
      orchestratorState !== ORCHESTRATOR_STATES.SPEAKING &&
      orchestratorState !== ORCHESTRATOR_STATES.THINKING
    ) {
      return;
    }
    const sessionId = activeSessionId || "default";
    tts?.abortSession?.(sessionId);
    llm?.abortSession?.(sessionId);
    const clearedBySession = peer?.clearOutgoingOpusQueue?.(sessionId);
    if (!clearedBySession) {
      peer?.clearOutgoingOpusQueue?.();
    }
    setState(ORCHESTRATOR_STATES.LISTENING, reason);
    bargeInSpeechStreak = 0;
  }

  function isLikelyHumanSpeechChunk(chunk) {
    if (!chunk || chunk.length < 2) {
      return false;
    }
    let sumSquares = 0;
    let samples = 0;
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i);
      sumSquares += sample * sample;
      samples += 1;
    }
    if (samples === 0) {
      return false;
    }
    const rms = Math.sqrt(sumSquares / samples);
    return rms >= BARGE_IN_RMS_THRESHOLD;
  }

  function clearUserTurnFinalizeTimer() {
    if (userTurnFinalizeTimer) {
      clearTimeout(userTurnFinalizeTimer);
      userTurnFinalizeTimer = null;
    }
  }

  function scheduleUserTurnFinalize() {
    clearUserTurnFinalizeTimer();
    userTurnFinalizeTimer = setTimeout(() => {
      userTurnFinalizeTimer = null;
      const mergedAudio =
        pendingUserTurnChunks.length > 0
          ? Buffer.concat(pendingUserTurnChunks)
          : Buffer.alloc(0);
      const mergedDuration = pendingUserTurnDurationMs;
      pendingUserTurnChunks = [];
      pendingUserTurnDurationMs = 0;

      userTurnFlow = userTurnFlow
        .then(() => processUserSpeech(mergedAudio, mergedDuration))
        .catch((error) => {
          console.error(
            `Failed user speech flow: ${error?.message || String(error)}`
          );
          setState(ORCHESTRATOR_STATES.LISTENING, "speech recovery fallback");
        });
    }, USER_TURN_FINALIZE_SILENCE_MS);
  }
  const vad = createVADHandler({
    onSpeechStart: () => {
      clearUserTurnFinalizeTimer();
      isCollectingUserSpeech = true;
      userSpeechChunks = [];
      bargeInSpeechStreak = 0;
      if (
        orchestratorState === ORCHESTRATOR_STATES.SPEAKING ||
        orchestratorState === ORCHESTRATOR_STATES.THINKING
      ) {
        interruptAssistantForUserSpeech("user interrupted assistant");
      }
    },
    onPCMChunk: (chunk) => {
      if (
        orchestratorState === ORCHESTRATOR_STATES.SPEAKING ||
        orchestratorState === ORCHESTRATOR_STATES.THINKING
      ) {
        const withinGraceWindow =
          Date.now() - lastAssistantSpeakStartAt < ASSISTANT_SPEECH_GRACE_MS;
        if (!withinGraceWindow && isLikelyHumanSpeechChunk(chunk)) {
          bargeInSpeechStreak += 1;
          if (bargeInSpeechStreak >= BARGE_IN_MIN_CONSECUTIVE_CHUNKS) {
            interruptAssistantForUserSpeech("user barge-in (live audio)");
            if (!isCollectingUserSpeech) {
              isCollectingUserSpeech = true;
              userSpeechChunks = [];
            }
          }
        } else if (!isLikelyHumanSpeechChunk(chunk)) {
          bargeInSpeechStreak = 0;
        }
      }
      if (!isCollectingUserSpeech) {
        return;
      }
      userSpeechChunks.push(Buffer.from(chunk));
    },
    onSpeechEnd: ({ duration }) => {
      if (!isCollectingUserSpeech) {
        return;
      }
      isCollectingUserSpeech = false;
      const bufferedSegment =
        userSpeechChunks.length > 0
          ? Buffer.concat(userSpeechChunks)
          : Buffer.alloc(0);
      userSpeechChunks = [];

      if (bufferedSegment.length > 0 && duration > 0) {
        pendingUserTurnChunks.push(bufferedSegment);
        pendingUserTurnDurationMs += duration;
      }
      scheduleUserTurnFinalize();
    },
  });
  await vad.start();

  peer = createWebRTCPeer({ signalingClient, vadHandler: vad });
  signalingClient.onIncomingCall(async (payload) => {
    try {
      if (payload?.from) {
        activeSessionId = payload.from;
      }
      const sessionId = activeSessionId || "default";
      await peer.handleIncomingCall(payload);
      const turnId = beginNewTurn();
      await llm.startConversation(sessionId, tts, turnId);
    } catch (error) {
      console.error("Failed handling incoming call:", error);
    }
  });
  signalingClient.onIceCandidate(async (payload) => {
    try {
      await peer.handleRemoteIceCandidate(payload);
    } catch (error) {
      console.error("Failed handling remote ICE candidate:", error);
    }
  });
  signalingClient.onPeerEndedCall(async (payload) => {
    try {
      await peer.handlePeerEndedCall(payload);
      if (payload?.from && payload.from === activeSessionId) {
        activeSessionId = "default";
        llm?.clearContext?.(payload.from);
      }
    } catch (error) {
      console.error("Failed handling peer-ended-call:", error);
    }
  });

  stt = createSTTHandler();
  llm = createLLMHandler({
    onThinkingStart: (sessionId, turnId = 0) => {
      if (turnId !== activeTurnId) {
        return;
      }
      activeSessionId = sessionId || activeSessionId;
      setState(ORCHESTRATOR_STATES.THINKING, "STT/LLM started");
    },
    onThinkingEnd: (_, turnId = 0) => {
      if (turnId !== activeTurnId) {
        return;
      }
      if (orchestratorState === ORCHESTRATOR_STATES.THINKING) {
        setState(ORCHESTRATOR_STATES.LISTENING, "LLM finished without speech");
      }
    },
    onAssistantSpeakStart: (sessionId, turnId = 0) => {
      if (turnId !== activeTurnId) {
        return;
      }
      lastAssistantSpeakStartAt = Date.now();
      bargeInSpeechStreak = 0;
      activeSessionId = sessionId || activeSessionId;
      setState(ORCHESTRATOR_STATES.SPEAKING, "TTS playing");
    },
    onAssistantSpeakEnd: (_, event = {}) => {
      const callbackTurnId = event?.turnId || 0;
      if (callbackTurnId !== activeTurnId) {
        return;
      }
      lastAssistantSpeakEndAt = Date.now();
      if (event?.interrupted) {
        return;
      }
      if (orchestratorState !== ORCHESTRATOR_STATES.SPEAKING) {
        return;
      }
      setState(ORCHESTRATOR_STATES.LISTENING, "TTS finished");
    }
  });
  tts = createTTSHandler({
    voice: process.env.TTS_VOICE || "nova",
    model: process.env.TTS_MODEL || "tts-1",
    speed: Number(process.env.TTS_SPEED) || 1.3,
    pushOpusFrame: (opusFrame, sessionId) =>
      peer.queueOutgoingOpusFrame(opusFrame, sessionId)
  });

  console.log("AI peer service bootstrapped.");
  return {
    signalingClient,
    peer,
    vad,
    stt,
    llm,
    tts,
    orchestration: {
      states: ORCHESTRATOR_STATES,
      getState: () => orchestratorState,
      getActiveSessionId: () => activeSessionId,
      setState
    }
  };
}

bootstrap().catch((error) => {
  console.error("AI peer service failed to start:", error);
  process.exit(1);
});
