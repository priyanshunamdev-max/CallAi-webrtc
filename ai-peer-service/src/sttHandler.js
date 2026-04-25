const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

function pcm16MonoToWavBuffer(pcmBuffer, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function createSTTHandler(options = {}) {
  const client = new OpenAI({
    apiKey: options.apiKey || process.env.OPENAI_API_KEY
  });
  const requestTimeoutMs = Number(process.env.STT_REQUEST_TIMEOUT_MS || 18000);
  const maxRetries = Math.max(0, Number(process.env.STT_MAX_RETRIES || 1));
  const retryDelayMs = Number(process.env.STT_RETRY_DELAY_MS || 300);

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isRetryableSttError(error) {
    const status = Number(error?.status ?? error?.response?.status);
    if (status === 408 || status === 409 || status === 429) {
      return true;
    }
    if (status >= 500 && status < 600) {
      return true;
    }
    const code = String(error?.code || "");
    return ["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN"].includes(code);
  }

  return {
    async transcribeChunk(audioBuffer) {
      if (!audioBuffer || audioBuffer.length === 0) {
        return "";
      }

      const wavBuffer = pcm16MonoToWavBuffer(audioBuffer, 16000);
      let lastError = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const file = await toFile(wavBuffer, "speech.wav", { type: "audio/wav" });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const result = await client.audio.transcriptions.create(
            {
              file,
              model: "whisper-1"
            },
            { signal: controller.signal }
          );
          clearTimeout(timeout);
          return (result?.text || "").trim();
        } catch (error) {
          clearTimeout(timeout);
          lastError = error;
          const isAbort = error?.name === "AbortError" || error?.code === "ABORT_ERR";
          const canRetry = attempt < maxRetries && (isAbort || isRetryableSttError(error));
          if (!canRetry) {
            break;
          }
          await wait(retryDelayMs * (attempt + 1));
        }
      }

      throw lastError;
    }
  };
}

module.exports = { createSTTHandler };
