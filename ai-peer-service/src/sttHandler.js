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

  return {
    async transcribeChunk(audioBuffer) {
      if (!audioBuffer || audioBuffer.length === 0) {
        return "";
      }

      const wavBuffer = pcm16MonoToWavBuffer(audioBuffer, 16000);
      const file = await toFile(wavBuffer, "speech.wav", { type: "audio/wav" });
      const result = await client.audio.transcriptions.create({
        file,
        model: "whisper-1"
      });

      return (result?.text || "").trim();
    }
  };
}

module.exports = { createSTTHandler };
