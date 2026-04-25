const { PassThrough } = require("stream");
const { RTCPeerConnection, RTCIceCandidate, MediaStreamTrack, RtpPacket, RtpHeader } = require("werift");

function createOpusDecoder() {
  try {
    const { OpusEncoder } = require("@discordjs/opus");
    console.log("[WebRTC] Opus decoder backend: @discordjs/opus (native)");
    return new OpusEncoder(48000, 1);
  } catch (discordOpusError) {
    try {
      const OpusScript = require("opusscript");
      console.warn("[WebRTC] Opus decoder backend: opusscript (JS fallback)");
      return new OpusScript(48000, 1, OpusScript.Application.AUDIO);
    } catch (opusScriptError) {
      console.error("Failed loading Opus decoder (@discordjs/opus, opusscript):", {
        discordOpusError,
        opusScriptError
      });
      throw opusScriptError;
    }
  }
}

function decodeOpusFrame(decoder, opusFrame) {
  // @discordjs/opus and opusscript both expose decode(), but opusscript
  // expects a frame size argument and may return Int16Array.
  if (typeof decoder.setBitrate === "function") {
    return decoder.decode(opusFrame);
  }

  const decoded = decoder.decode(opusFrame, 960);
  if (Buffer.isBuffer(decoded)) {
    return decoded;
  }
  return Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function downsample48kTo16k(pcm48kBuffer) {
  // PCM16 mono: 3:1 decimation from 48kHz -> 16kHz.
  if (!pcm48kBuffer || pcm48kBuffer.length < 6) {
    return Buffer.alloc(0);
  }

  const sourceSamples = Math.floor(pcm48kBuffer.length / 2);
  const targetSamples = Math.floor(sourceSamples / 3);
  const out = Buffer.alloc(targetSamples * 2);

  for (let i = 0; i < targetSamples; i += 1) {
    const sourceOffset = i * 3 * 2;
    const sample = pcm48kBuffer.readInt16LE(sourceOffset);
    out.writeInt16LE(sample, i * 2);
  }

  return out;
}

function createWebRTCPeer({ signalingClient, vadHandler }) {
  /** @type {Map<string, { pc: RTCPeerConnection, pendingIce: any[], rtpSubscriptions: Array<() => void>, pcmStream: PassThrough, localAudioTrack: MediaStreamTrack, outgoing: { sequenceNumber: number, timestamp: number, ssrc: number, sendQueue: Promise<void>, queueVersion: number } }>} */
  const peers = new Map();
  const RTP_TIMESTAMP_STEP = 960; // 20ms Opus packet clocked at 48kHz

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getPeer(remoteUserId) {
    return peers.get(remoteUserId);
  }

  async function closePeer(remoteUserId) {
    const peer = peers.get(remoteUserId);
    if (!peer) return;
    peer.rtpSubscriptions.forEach((unsub) => {
      try {
        unsub();
      } catch (error) {
        console.warn(`Failed to unsubscribe RTP handler for ${remoteUserId}:`, error);
      }
    });
    peer.pcmStream.end();
    peer.localAudioTrack.stop();
    try {
      await peer.pc.close();
    } catch (error) {
      console.warn(`Failed closing peer for ${remoteUserId}:`, error);
    }
    peers.delete(remoteUserId);
  }

  function createPeer(remoteUserId) {
    const existing = getPeer(remoteUserId);
    if (existing) {
      void closePeer(remoteUserId);
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const localAudioTrack = new MediaStreamTrack({ kind: "audio" });
    // Keep a single negotiated audio m-line with bidirectional media.
    pc.addTransceiver(localAudioTrack, { direction: "sendrecv" });

    const peer = {
      pc,
      pendingIce: [],
      rtpSubscriptions: [],
      pcmStream: new PassThrough(),
      localAudioTrack,
      outgoing: {
        sequenceNumber: Math.floor(Math.random() * 65535),
        timestamp: Math.floor(Math.random() * 0xffffffff),
        ssrc: Math.floor(Math.random() * 0xffffffff),
        sendQueue: Promise.resolve(),
        queueVersion: 0,
        nextSendAtMs: 0
      }
    };
    peers.set(remoteUserId, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      signalingClient.emit("ice-candidate", {
        to: remoteUserId,
        candidate: candidate.toJSON()
      });
    };

    pc.ontrack = (event) => {
      console.log(`Received remote track from ${remoteUserId}:`, event.track?.kind || "unknown");
      const track = event.track;
      if (!track || track.kind !== "audio") {
        return;
      }

      // Decode Opus RTP payload, then convert 48kHz mono PCM -> 16kHz for VAD/STT.
      const decoder = createOpusDecoder();
      const subscription = track.onReceiveRtp.subscribe((rtpPacket) => {
        try {
          const opusFrame = rtpPacket?.payload;
          if (!opusFrame || opusFrame.length === 0) return;

          const pcm48kChunk = decodeOpusFrame(decoder, opusFrame);
          const pcmChunk = downsample48kTo16k(pcm48kChunk);
          if (!pcmChunk.length) {
            return;
          }
          peer.pcmStream.write(pcmChunk);
          vadHandler?.pushPCMChunk(pcmChunk);
        } catch (error) {
          console.warn(`Opus decode failed for ${remoteUserId}:`, error);
        }
      });

      peer.rtpSubscriptions.push(subscription.unSubscribe);
    };

    pc.onconnectionstatechange = () => {
      console.log(`Peer ${remoteUserId} connectionState: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        void closePeer(remoteUserId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`Peer ${remoteUserId} iceConnectionState: ${pc.iceConnectionState}`);
    };

    return peer;
  }

  async function applyPendingIce(remoteUserId) {
    const peer = getPeer(remoteUserId);
    if (!peer || !peer.pc.remoteDescription) return;

    while (peer.pendingIce.length > 0) {
      const candidate = peer.pendingIce.shift();
      if (!candidate) continue;
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn(`Failed pending ICE add for ${remoteUserId}:`, error);
      }
    }
  }

  async function handleIncomingCall({ from, offer }) {
    if (!from || !offer?.sdp || !offer?.type) {
      console.warn("Invalid incoming-call payload:", { from, hasOffer: Boolean(offer) });
      return;
    }

    const peer = createPeer(from);
    const { pc } = peer;
    console.log(`Incoming call from ${from}. Creating WebRTC answer.`);

    await pc.setRemoteDescription(offer);
    await applyPendingIce(from);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    signalingClient.emit("accept-call", {
      to: from,
      answer: {
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp
      }
    });
    console.log(`Sent WebRTC answer to ${from}.`);
  }

  async function handleRemoteIceCandidate({ from, candidate }) {
    if (!from || !candidate) return;

    const peer = getPeer(from);
    if (!peer) {
      console.log(`No active peer for ${from}. Ignoring ICE candidate.`);
      return;
    }

    const normalized = candidate instanceof RTCIceCandidate ? candidate : new RTCIceCandidate(candidate);

    if (!peer.pc.remoteDescription) {
      peer.pendingIce.push(normalized);
      return;
    }
    await peer.pc.addIceCandidate(normalized);
  }

  async function handlePeerEndedCall({ from }) {
    if (!from) return;
    await closePeer(from);
    console.log(`Peer ${from} ended the call.`);
  }

  function getDefaultPeerId() {
    if (peers.size !== 1) {
      return null;
    }
    return peers.keys().next().value || null;
  }

  function queueOutgoingOpusFrame(opusFrame, remoteUserId) {
    const targetPeerId = remoteUserId || getDefaultPeerId();
    if (!targetPeerId) {
      return false;
    }

    const peer = getPeer(targetPeerId);
    if (!peer || !peer.localAudioTrack) {
      return false;
    }

    const frameVersion = peer.outgoing.queueVersion;
    peer.outgoing.sendQueue = peer.outgoing.sendQueue
      .then(async () => {
        if (frameVersion !== peer.outgoing.queueVersion) {
          return;
        }
        const header = new RtpHeader({
          payloadType: 111,
          sequenceNumber: peer.outgoing.sequenceNumber,
          timestamp: peer.outgoing.timestamp,
          ssrc: peer.outgoing.ssrc,
          marker: true
        });
        const packet = new RtpPacket(header, opusFrame);
        peer.localAudioTrack.writeRtp(packet);

        peer.outgoing.sequenceNumber = (peer.outgoing.sequenceNumber + 1) & 0xffff;
        peer.outgoing.timestamp = (peer.outgoing.timestamp + RTP_TIMESTAMP_STEP) >>> 0;

        // Pace to ~20ms/frame without compounding delay when synthesis already takes time.
        const now = Date.now();
        if (!peer.outgoing.nextSendAtMs || peer.outgoing.nextSendAtMs < now) {
          peer.outgoing.nextSendAtMs = now + 20;
          return;
        }

        const delayMs = peer.outgoing.nextSendAtMs - now;
        peer.outgoing.nextSendAtMs += 20;
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      })
      .catch((error) => {
        console.warn(`Failed sending outgoing Opus frame to ${targetPeerId}:`, error);
      });

    return true;
  }

  function clearOutgoingOpusQueue(remoteUserId) {
    const targetPeerId = remoteUserId || getDefaultPeerId();
    if (!targetPeerId) {
      return false;
    }

    const peer = getPeer(targetPeerId);
    if (!peer) {
      return false;
    }

    peer.outgoing.queueVersion += 1;
    peer.outgoing.sendQueue = Promise.resolve();
    peer.outgoing.nextSendAtMs = 0;
    return true;
  }

  return {
    handleIncomingCall,
    handleRemoteIceCandidate,
    handlePeerEndedCall,
    closePeer,
    queueOutgoingOpusFrame,
    clearOutgoingOpusQueue
  };
}

module.exports = { createWebRTCPeer };
