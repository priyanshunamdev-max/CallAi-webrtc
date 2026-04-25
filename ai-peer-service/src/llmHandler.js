// const OpenAI = require("openai");

// function createLLMHandler(options = {}) {
//   const client = new OpenAI({
//     apiKey: process.env.OPENAI_API_KEY
//   });
//   const systemInstruction =
//     "You are a helpful voice assistant. Always respond in English only, regardless of the user's language. Keep responses concise, natural, and usually under 2 sentences unless asked for detail.";
//   const sessions = new Map();
//   /** @type {Map<string, { controller: AbortController, interrupted: boolean }>} */
//   const activeStreams = new Map();

//   function getSessionHistory(sessionId = "default") {
//     if (!sessions.has(sessionId)) {
//       sessions.set(sessionId, []);
//     }
//     return sessions.get(sessionId);
//   }

//   function appendMessage(sessionId, role, content) {
//     const history = getSessionHistory(sessionId);
//     history.push({ role, content });
//   }

//   async function streamAssistantResponse(sessionId = "default", ttsHandler) {
//     const history = getSessionHistory(sessionId);
//     if (history.length === 0) {
//       return "";
//     }

//     const controller = new AbortController();
//     activeStreams.set(sessionId, { controller, interrupted: false });
//     let assistantText = "";
//     let ttsBuffer = "";
//     let logBuffer = "";
//     let flushTimer = null;
//     let assistantSpeakStarted = false;

//     async function flushTtsBufferAsync() {
//       if (!ttsBuffer?.trim()) {
//         ttsBuffer = "";
//         return;
//       }
//       const chunk = ttsBuffer;
//       ttsBuffer = "";
//       if (!ttsHandler?.synthesizeStream) {
//         return;
//       }
//       if (!assistantSpeakStarted && typeof options.onAssistantSpeakStart === "function") {
//         assistantSpeakStarted = true;
//         options.onAssistantSpeakStart(sessionId);
//       }
//       await ttsHandler.synthesizeStream(sessionId, chunk);
//     }

//     function flushLogBuffer() {
//       if (!logBuffer) {
//         return;
//       }
//       const chunk = logBuffer;
//       logBuffer = "";
//       console.log(`[LLM ${sessionId}] ${chunk}`);
//     }

//     function scheduleIdleFlush() {
//       if (flushTimer) {
//         clearTimeout(flushTimer);
//       }
//       flushTimer = setTimeout(() => {
//         flushTimer = null;
//         void flushTtsBufferAsync().catch((error) => {
//           console.error("TTS idle flush failed:", error);
//         });
//       }, 220);
//     }

//     let wasInterrupted = false;

//     try {
//       try {
//         const stream = await client.chat.completions.create({
//           model: "gpt-4o-mini",
//           messages: [{ role: "system", content: systemInstruction }, ...history],
//           stream: true
//         }, { signal: controller.signal });

//         for await (const chunk of stream) {
//           const delta = chunk?.choices?.[0]?.delta?.content;
//           if (!delta) {
//             continue;
//           }

//           assistantText += delta;
//           logBuffer += delta;
//           if (logBuffer.length >= 160) {
//             flushLogBuffer();
//           }

//           ttsBuffer += delta;
//           const reachedSentenceBoundary = /[.!?]\s*$|\n$/.test(ttsBuffer);
//           const reachedSoftBoundary = /[,;:]\s*$/.test(ttsBuffer);
//           const reachedChunkSize = ttsBuffer.length >= 140;
//           if (reachedSentenceBoundary || reachedChunkSize || (reachedSoftBoundary && ttsBuffer.length >= 40)) {
//             if (flushTimer) {
//               clearTimeout(flushTimer);
//               flushTimer = null;
//             }
//             await flushTtsBufferAsync();
//           } else {
//             scheduleIdleFlush();
//           }
//         }
//         if (flushTimer) {
//           clearTimeout(flushTimer);
//           flushTimer = null;
//         }
//         await flushTtsBufferAsync();
//         flushLogBuffer();
//       } catch (error) {
//         if (flushTimer) {
//           clearTimeout(flushTimer);
//           flushTimer = null;
//         }
//         const isAbort =
//           error?.name === "AbortError" || error?.code === "ABORT_ERR" || /abort/i.test(String(error?.message || ""));
//         if (!isAbort) {
//           throw error;
//         }
//       }

//       const streamState = activeStreams.get(sessionId);
//       activeStreams.delete(sessionId);
//       wasInterrupted = Boolean(streamState?.interrupted);

//       try {
//         if (ttsHandler?.drainSession) {
//           await ttsHandler.drainSession(sessionId);
//         }
//         if (!wasInterrupted && ttsHandler?.flushSession) {
//           await ttsHandler.flushSession(sessionId);
//         }
//         if (ttsHandler?.drainSession) {
//           await ttsHandler.drainSession(sessionId);
//         }
//       } catch (error) {
//         console.error("TTS drain/flush failed:", error);
//       }

//       if (!wasInterrupted && assistantText.trim()) {
//         appendMessage(sessionId, "assistant", assistantText);
//       }

//       return assistantText;
//     } finally {
//       if (activeStreams.has(sessionId)) {
//         const streamState = activeStreams.get(sessionId);
//         wasInterrupted = wasInterrupted || Boolean(streamState?.interrupted);
//         activeStreams.delete(sessionId);
//       }
//       if (assistantSpeakStarted && typeof options.onAssistantSpeakEnd === "function") {
//         options.onAssistantSpeakEnd(sessionId);
//       }
//     }
//   }

//   return {
//     async handleFinalTranscript(sessionId = "default", transcript = "", ttsHandler) {
//       const normalized = transcript.trim();
//       if (!normalized) {
//         return "";
//       }

//       appendMessage(sessionId, "user", normalized);
//       if (typeof options.onThinkingStart === "function") {
//         options.onThinkingStart(sessionId);
//       }
//       try {
//         return await streamAssistantResponse(sessionId, ttsHandler);
//       } finally {
//         if (typeof options.onThinkingEnd === "function") {
//           options.onThinkingEnd(sessionId);
//         }
//       }
//     },
//     async handleInterruptionTranscript(sessionId = "default", transcript = "", ttsHandler) {
//       const normalized = transcript.trim();
//       if (!normalized) {
//         return "";
//       }

//       const history = getSessionHistory(sessionId);
//       if (history.length > 0 && history[history.length - 1].role === "assistant") {
//         history.pop();
//       }
//       appendMessage(sessionId, "user", normalized);
//       if (typeof options.onThinkingStart === "function") {
//         options.onThinkingStart(sessionId);
//       }
//       try {
//         return await streamAssistantResponse(sessionId, ttsHandler);
//       } finally {
//         if (typeof options.onThinkingEnd === "function") {
//           options.onThinkingEnd(sessionId);
//         }
//       }
//     },
//     abortSession(sessionId = "default") {
//       const active = activeStreams.get(sessionId);
//       if (!active) {
//         return;
//       }
//       active.interrupted = true;
//       active.controller.abort();
//     },
//     getHistory(sessionId = "default") {
//       return [...getSessionHistory(sessionId)];
//     },
//     clearHistory(sessionId = "default") {
//       sessions.delete(sessionId);
//     }
//   };
// }

// module.exports = { createLLMHandler };


const OpenAI = require("openai");

function createLLMHandler(options = {}) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  const systemInstruction =
    "You are a helpful voice assistant. Always respond in English only, regardless of the user's language. Keep responses concise, natural, and usually under 2 sentences unless asked for detail.";
  const sessions = new Map();
  /** @type {Map<string, { controller: AbortController, interrupted: boolean }>} */
  const activeStreams = new Map();

  function getSessionHistory(sessionId = "default") {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
    }
    return sessions.get(sessionId);
  }

  function appendMessage(sessionId, role, content) {
    const history = getSessionHistory(sessionId);
    history.push({ role, content });
  }

  async function streamAssistantResponse(sessionId = "default", ttsHandler) {
    const history = getSessionHistory(sessionId);
    if (history.length === 0) {
      return "";
    }

    const controller = new AbortController();
    activeStreams.set(sessionId, { controller, interrupted: false });
    let assistantText = "";
    let ttsBuffer = "";
    let logBuffer = "";
    let flushTimer = null;
    let assistantSpeakStarted = false;

    async function flushTtsBufferAsync() {
      if (!ttsBuffer?.trim()) {
        ttsBuffer = "";
        return;
      }
      const chunk = ttsBuffer;
      ttsBuffer = "";
      if (!ttsHandler?.synthesizeStream) {
        return;
      }
      if (!assistantSpeakStarted && typeof options.onAssistantSpeakStart === "function") {
        assistantSpeakStarted = true;
        options.onAssistantSpeakStart(sessionId);
      }
      await ttsHandler.synthesizeStream(sessionId, chunk);
    }

    function flushLogBuffer() {
      if (!logBuffer) {
        return;
      }
      const chunk = logBuffer;
      logBuffer = "";
      console.log(`[LLM ${sessionId}] ${chunk}`);
    }

    function scheduleIdleFlush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushTtsBufferAsync().catch((error) => {
          console.error("TTS idle flush failed:", error);
        });
      }, 120);
    }

    let wasInterrupted = false;

    try {
      try {
        const stream = await client.chat.completions.create(
          {
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemInstruction }, ...history],
            stream: true
          },
          { signal: controller.signal }
        );

        for await (const chunk of stream) {
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (!delta) {
            continue;
          }

          assistantText += delta;
          logBuffer += delta;
          if (logBuffer.length >= 160) {
            flushLogBuffer();
          }

          ttsBuffer += delta;
          const reachedSentenceBoundary = /[.!?]\s*$|\n$/.test(ttsBuffer);
          const reachedSoftBoundary = /[,;:]\s*$/.test(ttsBuffer);
          const reachedChunkSize = ttsBuffer.length >= 80;
          if (reachedSentenceBoundary || reachedChunkSize || (reachedSoftBoundary && ttsBuffer.length >= 24)) {
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            await flushTtsBufferAsync();
          } else {
            scheduleIdleFlush();
          }
        }
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flushTtsBufferAsync();
        flushLogBuffer();
      } catch (error) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        const isAbort =
          error?.name === "AbortError" ||
          error?.code === "ABORT_ERR" ||
          /abort/i.test(String(error?.message || ""));
        if (!isAbort) {
          throw error;
        }
      }

      const streamState = activeStreams.get(sessionId);
      activeStreams.delete(sessionId);
      wasInterrupted = Boolean(streamState?.interrupted);

      try {
        if (ttsHandler?.drainSession) {
          await ttsHandler.drainSession(sessionId);
        }
        if (!wasInterrupted && ttsHandler?.flushSession) {
          await ttsHandler.flushSession(sessionId);
        }
        if (ttsHandler?.drainSession) {
          await ttsHandler.drainSession(sessionId);
        }
      } catch (error) {
        console.error("TTS drain/flush failed:", error);
      }

      if (!wasInterrupted && assistantText.trim()) {
        appendMessage(sessionId, "assistant", assistantText);
      }

      return assistantText;
    } finally {
      if (activeStreams.has(sessionId)) {
        const streamState = activeStreams.get(sessionId);
        wasInterrupted = wasInterrupted || Boolean(streamState?.interrupted);
        activeStreams.delete(sessionId);
      }
      if (assistantSpeakStarted && typeof options.onAssistantSpeakEnd === "function") {
        options.onAssistantSpeakEnd(sessionId);
      }
    }
  }

  return {
    async handleFinalTranscript(sessionId = "default", transcript = "", ttsHandler) {
      const normalized = transcript.trim();
      if (!normalized) {
        return "";
      }
      appendMessage(sessionId, "user", normalized);
      if (typeof options.onThinkingStart === "function") {
        options.onThinkingStart(sessionId);
      }
      try {
        return await streamAssistantResponse(sessionId, ttsHandler);
      } finally {
        if (typeof options.onThinkingEnd === "function") {
          options.onThinkingEnd(sessionId);
        }
      }
    },
    async handleInterruptionTranscript(sessionId = "default", transcript = "", ttsHandler) {
      const normalized = transcript.trim();
      if (!normalized) {
        return "";
      }
      const history = getSessionHistory(sessionId);
      if (history.length > 0 && history[history.length - 1].role === "assistant") {
        history.pop();
      }
      appendMessage(sessionId, "user", normalized);
      if (typeof options.onThinkingStart === "function") {
        options.onThinkingStart(sessionId);
      }
      try {
        return await streamAssistantResponse(sessionId, ttsHandler);
      } finally {
        if (typeof options.onThinkingEnd === "function") {
          options.onThinkingEnd(sessionId);
        }
      }
    },
    abortSession(sessionId = "default") {
      const active = activeStreams.get(sessionId);
      if (!active) {
        return;
      }
      active.interrupted = true;
      active.controller.abort();
    },
    getHistory(sessionId = "default") {
      return [...getSessionHistory(sessionId)];
    },
    clearHistory(sessionId = "default") {
      sessions.delete(sessionId);
    }
  };
}

module.exports = { createLLMHandler };