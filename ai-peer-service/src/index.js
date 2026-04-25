require("dotenv").config({ override: true });

const { createSignalingClient } = require("./signalingClient");
const { createWebRTCPeer } = require("./webrtcPeer");
const { createVADHandler } = require("./vadHandler");
const { createSTTHandler } = require("./sttHandler");
const { createLLMHandler } = require("./llmHandler");
const { createTTSHandler } = require("./ttsHandler");
const { createInterruptionController } = require("./interruption");

const ORCHESTRATOR_STATES = Object.freeze({
  LISTENING: "LISTENING",
  THINKING: "THINKING",
  SPEAKING: "SPEAKING",
  INTERRUPTED: "INTERRUPTED"
});

const ALLOW_BARGE_IN = process.env.ALLOW_BARGE_IN !== "false";
const MIN_USER_SEGMENT_MS = Number(process.env.MIN_USER_SEGMENT_MS || 300);
const MIN_INTERRUPTION_SEGMENT_MS = Number(process.env.MIN_INTERRUPTION_SEGMENT_MS || 180);
const USER_SEGMENT_MERGE_GAP_MS = Number(process.env.USER_SEGMENT_MERGE_GAP_MS || 420);
const MIN_USER_PART_MS = Number(process.env.MIN_USER_PART_MS || 120);

async function bootstrap() {
  const signalingClient = createSignalingClient({
    serverUrl: process.env.SIGNALING_SERVER_URL,
    aiUserId: process.env.AI_USER_ID || "ai_assistant"
  });

  const interruption = createInterruptionController();
  let orchestratorState = ORCHESTRATOR_STATES.LISTENING;
  let activeSessionId = "default";
  let collectingSpeech = false;
  let speechChunks = [];
  let speechStartedDuringSpeaking = false;
  let interruptionFlow = Promise.resolve();
  let pendingUserChunks = [];
  let pendingUserDurationMs = 0;
  let userMergeTimer = null;

  let stt;
  let llm;
  let tts;
  let peer;

  function getCurrentState() {
    return orchestratorState;
  }

  function setState(nextState, reason) {
    if (orchestratorState === nextState) {
      return;
    }
    const previous = orchestratorState;
    orchestratorState = nextState;
    console.log(`[ORCHESTRATOR] ${previous} -> ${nextState}${reason ? ` (${reason})` : ""}`);
  }

  async function handleInterruptionSegment(audioSegment, durationMs) {
    const sessionId = activeSessionId || "default";
    if (!interruption.getState().isInterrupted) {
      interruption.interrupt();
      setState(ORCHESTRATOR_STATES.INTERRUPTED, `speech detected during TTS (${durationMs}ms)`);
      tts?.abortSession?.(sessionId);
      llm?.abortSession?.(sessionId);
      const clearedBySession = peer?.clearOutgoingOpusQueue?.(sessionId);
      if (!clearedBySession) {
        peer?.clearOutgoingOpusQueue?.();
      }
    }

    if (!audioSegment || audioSegment.length === 0) {
      setState(ORCHESTRATOR_STATES.LISTENING, "empty interruption segment");
      return;
    }

    setState(ORCHESTRATOR_STATES.THINKING, "transcribing interruption");
    const transcript = await stt.transcribeChunk(audioSegment);
    if (!transcript) {
      setState(ORCHESTRATOR_STATES.LISTENING, "interruption transcript was empty");
      return;
    }

    console.log(`[ORCHESTRATOR] interruption transcript: ${transcript}`);
    await llm.handleInterruptionTranscript(sessionId, transcript, tts);
  }

  async function handleUserSpeechSegment(audioSegment, durationMs) {
    const sessionId = activeSessionId || "default";
    if (!audioSegment || audioSegment.length === 0) {
      return;
    }

    setState(ORCHESTRATOR_STATES.THINKING, `transcribing user speech (${durationMs}ms)`);
    const transcript = await stt.transcribeChunk(audioSegment);
    if (!transcript) {
      setState(ORCHESTRATOR_STATES.LISTENING, "user transcript was empty");
      return;
    }

    console.log(`[ORCHESTRATOR] user transcript: ${transcript}`);
    await llm.handleFinalTranscript(sessionId, transcript, tts);
  }

  function clearUserMergeTimer() {
    if (userMergeTimer) {
      clearTimeout(userMergeTimer);
      userMergeTimer = null;
    }
  }

  function scheduleMergedUserSegment() {
    clearUserMergeTimer();
    userMergeTimer = setTimeout(() => {
      userMergeTimer = null;
      const mergedDurationMs = pendingUserDurationMs;
      const mergedAudio = pendingUserChunks.length > 0 ? Buffer.concat(pendingUserChunks) : Buffer.alloc(0);
      pendingUserChunks = [];
      pendingUserDurationMs = 0;

      if (!mergedAudio.length || mergedDurationMs <= MIN_USER_SEGMENT_MS) {
        return;
      }

      interruptionFlow = interruptionFlow
        .then(() => handleUserSpeechSegment(mergedAudio, mergedDurationMs))
        .catch((error) => {
          console.error("Failed merged user speech flow:", error);
          setState(ORCHESTRATOR_STATES.LISTENING, "merged user speech recovery fallback");
        });
    }, USER_SEGMENT_MERGE_GAP_MS);
  }

  const vad = createVADHandler({
    onSpeechStart: () => {
      clearUserMergeTimer();
      const currentState = getCurrentState();
      const canCaptureListening = currentState === ORCHESTRATOR_STATES.LISTENING;
      const canCaptureInterruption = ALLOW_BARGE_IN && currentState === ORCHESTRATOR_STATES.SPEAKING;

      if (!canCaptureListening && !canCaptureInterruption) {
        collectingSpeech = false;
        speechChunks = [];
        speechStartedDuringSpeaking = false;
        return;
      }

      collectingSpeech = true;
      speechChunks = [];
      speechStartedDuringSpeaking = canCaptureInterruption;
      if (canCaptureInterruption) {
        const sessionId = activeSessionId || "default";
        interruption.interrupt();
        setState(ORCHESTRATOR_STATES.INTERRUPTED, "barge-in speechStart detected");
        tts?.abortSession?.(sessionId);
        llm?.abortSession?.(sessionId);
        const clearedBySession = peer?.clearOutgoingOpusQueue?.(sessionId);
        if (!clearedBySession) {
          peer?.clearOutgoingOpusQueue?.();
        }
      }
    },
    onPCMChunk: (chunk) => {
      if (!collectingSpeech) {
        return;
      }
      speechChunks.push(Buffer.from(chunk));
    },
    onSpeechEnd: ({ duration }) => {
      const wasCollecting = collectingSpeech;
      const startedDuringSpeaking = speechStartedDuringSpeaking;
      const bufferedSegment = speechChunks.length > 0 ? Buffer.concat(speechChunks) : Buffer.alloc(0);

      collectingSpeech = false;
      speechChunks = [];
      speechStartedDuringSpeaking = false;
      if (!wasCollecting) {
        return;
      }

      if (startedDuringSpeaking) {
        if (!ALLOW_BARGE_IN) {
          return;
        }
        if (duration <= MIN_INTERRUPTION_SEGMENT_MS) {
          setState(ORCHESTRATOR_STATES.LISTENING, "interruption too short");
          return;
        }
        interruptionFlow = interruptionFlow
          .then(() => handleInterruptionSegment(bufferedSegment, duration))
          .catch((error) => {
            console.error("Failed interruption flow:", error);
            setState(ORCHESTRATOR_STATES.LISTENING, "interruption recovery fallback");
          });
        return;
      }

      if (duration <= MIN_USER_PART_MS || !bufferedSegment.length) {
        return;
      }
      pendingUserChunks.push(bufferedSegment);
      pendingUserDurationMs += duration;
      scheduleMergedUserSegment();
    }
  });
  await vad.start();

  peer = createWebRTCPeer({ signalingClient, vadHandler: vad });
  signalingClient.onIncomingCall(async (payload) => {
    try {
      if (payload?.from) {
        activeSessionId = payload.from;
      }
      await peer.handleIncomingCall(payload);
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
      }
    } catch (error) {
      console.error("Failed handling peer-ended-call:", error);
    }
  });

  stt = createSTTHandler();
  llm = createLLMHandler({
    onThinkingStart: (sessionId) => {
      interruption.reset();
      activeSessionId = sessionId || activeSessionId;
      setState(ORCHESTRATOR_STATES.THINKING, "STT/LLM started");
    },
    onThinkingEnd: () => {
      if (getCurrentState() === ORCHESTRATOR_STATES.THINKING) {
        setState(ORCHESTRATOR_STATES.LISTENING, "LLM finished without speech");
      }
    },
    onAssistantSpeakStart: (sessionId) => {
      activeSessionId = sessionId || activeSessionId;
      setState(ORCHESTRATOR_STATES.SPEAKING, "TTS playing");
    },
    onAssistantSpeakEnd: () => {
      if (getCurrentState() === ORCHESTRATOR_STATES.INTERRUPTED) {
        return;
      }
      setState(ORCHESTRATOR_STATES.LISTENING, "TTS finished");
    }
  });
  tts = createTTSHandler({
    voice: process.env.TTS_VOICE || "nova",
    model: process.env.TTS_MODEL || "tts-1",
    speed: Number(process.env.TTS_SPEED) || 1.3,
    pushOpusFrame: (opusFrame, sessionId) => peer.queueOutgoingOpusFrame(opusFrame, sessionId)
  });

  console.log("AI peer service bootstrapped.");
  return {
    signalingClient,
    peer,
    vad,
    stt,
    llm,
    tts,
    interruption,
    orchestration: {
      states: ORCHESTRATOR_STATES,
      getState: getCurrentState,
      getActiveSessionId: () => activeSessionId,
      setState
    }
  };
}

bootstrap().catch((error) => {
  console.error("AI peer service failed to start:", error);
  process.exit(1);
});
