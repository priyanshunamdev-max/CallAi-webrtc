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

function applyGainPcm16Mono(pcmBuffer, gain = 1.0) {
  if (!pcmBuffer || pcmBuffer.length === 0 || gain === 1) {
    return pcmBuffer;
  }
  const out = Buffer.allocUnsafe(pcmBuffer.length);
  for (let i = 0; i + 1 < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    const boosted = Math.max(
      -32768,
      Math.min(32767, Math.round(sample * gain)),
    );
    out.writeInt16LE(boosted, i);
  }
  return out;
}

function createSTTHandler(options = {}) {
  const client = new OpenAI({
    apiKey: options.apiKey || process.env.OPENAI_API_KEY,
  });

  return {
    async transcribeChunk(audioBuffer) {
      if (!audioBuffer || audioBuffer.length === 0) {
        return "";
      }

      const wavBuffer = pcm16MonoToWavBuffer(audioBuffer, 16000);
      const file = await toFile(wavBuffer, "speech.wav", { type: "audio/wav" });
      const request = {
        file,
        model: "whisper-1",
        temperature: 0,
        language: "en",
        prompt: "Transcribe spoken English clearly.",
      };
      const result = await client.audio.transcriptions.create(request);
      const transcript = (result?.text || "").trim();
      if (transcript) {
        return transcript;
      }

      const boostedBuffer = applyGainPcm16Mono(audioBuffer, 1.8);
      const boostedWav = pcm16MonoToWavBuffer(boostedBuffer, 16000);
      const boostedFile = await toFile(boostedWav, "speech-boosted.wav", {
        type: "audio/wav",
      });
      const boostedResult = await client.audio.transcriptions.create({
        ...request,
        file: boostedFile,
      });
      return (boostedResult?.text || "").trim();
    },
  };
}

module.exports = { createSTTHandler };
