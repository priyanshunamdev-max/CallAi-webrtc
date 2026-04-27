const OpenAI = require("openai");

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful voice assistant. Understand and respond in English only. If the user speaks another language, politely ask them to continue in English. Keep responses short, clear, and conversational unless the user asks for detail.";
const DEFAULT_BOOTSTRAP_USER_PROMPT =
  "Start the call with a short friendly greeting in English and ask how you can help.";
const MAX_CONTEXT_MESSAGES = Number(process.env.LLM_MAX_CONTEXT_MESSAGES || 20);
const KEEP_PARTIAL_ASSISTANT_ON_INTERRUPT =
  process.env.KEEP_PARTIAL_ASSISTANT_ON_INTERRUPT !== "false";

function createLLMHandler(options = {}) {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  const systemPrompt = options.systemPrompt || process.env.AI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
  const baseUserPrompt = options.userPrompt || process.env.AI_USER_PROMPT || "";
  const startupUserPrompt = options.startupUserPrompt || process.env.AI_STARTUP_USER_PROMPT || DEFAULT_BOOTSTRAP_USER_PROMPT;
  const model = options.model || process.env.LLM_MODEL || "gpt-4o-mini";

  /** @type {Map<string, { context: Array<{ role: "user" | "assistant", content: string }> }>} */
  const sessions = new Map();
  /** @type {Map<string, { controller: AbortController, interrupted: boolean }>} */
  const activeStreams = new Map();

  function getSession(sessionId = "default") {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { context: [] });
    }
    return sessions.get(sessionId);
  }

  function addToContext(sessionId, role, content) {
    const normalized = String(content || "").trim();
    if (!normalized) {
      return;
    }
    const session = getSession(sessionId);
    session.context.push({ role, content: normalized });
    if (session.context.length > MAX_CONTEXT_MESSAGES) {
      session.context.splice(0, session.context.length - MAX_CONTEXT_MESSAGES);
    }
  }

  function normalizeInterruptedAssistantText(text) {
    const cleaned = String(text || "").trim();
    if (!cleaned) {
      return "";
    }
    if (/[.!?]$/.test(cleaned)) {
      return `${cleaned} [interrupted]`;
    }
    return `${cleaned}... [interrupted]`;
  }

  function buildMessages(sessionId, extraUserMessage = "") {
    const session = getSession(sessionId);
    /** @type {Array<{ role: "system" | "user" | "assistant", content: string }>} */
    const messages = [{ role: "system", content: systemPrompt }];

    if (baseUserPrompt.trim()) {
      messages.push({ role: "user", content: baseUserPrompt.trim() });
    }
    messages.push(...session.context);
    if (extraUserMessage.trim()) {
      messages.push({ role: "user", content: extraUserMessage.trim() });
    }

    return messages;
  }

  async function streamAssistantResponse(sessionId = "default", ttsHandler, turnId = 0, extraUserMessage = "") {
    const messages = buildMessages(sessionId, extraUserMessage);
    const controller = new AbortController();
    activeStreams.set(sessionId, { controller, interrupted: false });

    let assistantText = "";
    let ttsBuffer = "";
    let flushTimer = null;
    let assistantSpeakStarted = false;
    let wasInterrupted = false;

    function isInterrupted() {
      const state = activeStreams.get(sessionId);
      return Boolean(state?.interrupted || controller.signal.aborted);
    }

    async function flushTtsBuffer() {
      if (isInterrupted()) {
        ttsBuffer = "";
        return;
      }
      if (!ttsBuffer.trim() || !ttsHandler?.synthesizeStream) {
        ttsBuffer = "";
        return;
      }
      const chunk = ttsBuffer;
      ttsBuffer = "";
      if (!assistantSpeakStarted && typeof options.onAssistantSpeakStart === "function") {
        assistantSpeakStarted = true;
        options.onAssistantSpeakStart(sessionId, turnId);
      }
      await ttsHandler.synthesizeStream(sessionId, chunk);
    }

    function scheduleIdleFlush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushTtsBuffer().catch((error) => {
          console.error("TTS flush failed:", error);
        });
      }, 120);
    }

    try {
      try {
        const stream = await client.chat.completions.create(
          {
            model,
            messages,
            stream: true
          },
          { signal: controller.signal }
        );

        for await (const chunk of stream) {
          if (isInterrupted()) {
            break;
          }
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (!delta) {
            continue;
          }

          assistantText += delta;
          ttsBuffer += delta;

          const boundary = /[.!?]\s*$|\n$/.test(ttsBuffer) || ttsBuffer.length >= 80;
          if (boundary) {
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            await flushTtsBuffer();
          } else {
            scheduleIdleFlush();
          }
        }

        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!isInterrupted()) {
          await flushTtsBuffer();
        } else {
          ttsBuffer = "";
        }
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

      const state = activeStreams.get(sessionId);
      activeStreams.delete(sessionId);
      wasInterrupted = Boolean(state?.interrupted);

      if (ttsHandler?.drainSession) {
        await ttsHandler.drainSession(sessionId);
      }
      if (!wasInterrupted && ttsHandler?.flushSession) {
        await ttsHandler.flushSession(sessionId);
      }
      if (ttsHandler?.drainSession) {
        await ttsHandler.drainSession(sessionId);
      }

      const finalAssistantText = assistantText.trim();
      if (finalAssistantText) {
        if (wasInterrupted && KEEP_PARTIAL_ASSISTANT_ON_INTERRUPT) {
          addToContext(sessionId, "assistant", normalizeInterruptedAssistantText(finalAssistantText));
        } else if (!wasInterrupted) {
          addToContext(sessionId, "assistant", finalAssistantText);
        }
      }

      return assistantText;
    } finally {
      if (activeStreams.has(sessionId)) {
        const state = activeStreams.get(sessionId);
        wasInterrupted = wasInterrupted || Boolean(state?.interrupted);
        activeStreams.delete(sessionId);
      }
      if (assistantSpeakStarted && typeof options.onAssistantSpeakEnd === "function") {
        options.onAssistantSpeakEnd(sessionId, { turnId, interrupted: wasInterrupted });
      }
    }
  }

  async function runTurn(sessionId, transcript, ttsHandler, turnId) {
    const normalized = String(transcript || "").trim();
    if (!normalized) {
      return "";
    }
    addToContext(sessionId, "user", normalized);
    if (typeof options.onThinkingStart === "function") {
      options.onThinkingStart(sessionId, turnId);
    }
    try {
      return await streamAssistantResponse(sessionId, ttsHandler, turnId);
    } finally {
      if (typeof options.onThinkingEnd === "function") {
        options.onThinkingEnd(sessionId, turnId);
      }
    }
  }

  return {
    async startConversation(sessionId = "default", ttsHandler, turnId = 0) {
      if (typeof options.onThinkingStart === "function") {
        options.onThinkingStart(sessionId, turnId);
      }
      try {
        return await streamAssistantResponse(sessionId, ttsHandler, turnId, startupUserPrompt);
      } finally {
        if (typeof options.onThinkingEnd === "function") {
          options.onThinkingEnd(sessionId, turnId);
        }
      }
    },
    async handleUserTranscript(sessionId = "default", transcript = "", ttsHandler, turnId = 0) {
      return runTurn(sessionId, transcript, ttsHandler, turnId);
    },
    abortSession(sessionId = "default") {
      const active = activeStreams.get(sessionId);
      if (!active) {
        return;
      }
      active.interrupted = true;
      active.controller.abort();
    },
    getContext(sessionId = "default") {
      const session = getSession(sessionId);
      return [...session.context];
    },
    clearContext(sessionId = "default") {
      sessions.delete(sessionId);
    }
  };
}

module.exports = { createLLMHandler };