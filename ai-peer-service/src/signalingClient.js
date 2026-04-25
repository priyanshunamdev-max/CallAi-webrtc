const { io } = require("socket.io-client");

function createSignalingClient({ serverUrl, aiUserId }) {
  if (!serverUrl) {
    console.warn("SIGNALING_SERVER_URL is missing in environment variables.");
  }

  const socket = io(serverUrl || "", {
    transports: ["websocket"],
    autoConnect: true
  });

  socket.on("connect", () => {
    console.log("Signaling connected:", socket.id);
    socket.emit("register", aiUserId, (response) => {
      if (!response?.ok) {
        console.error("AI peer registration failed:", response?.error || "unknown error");
      }
    });
  });
  console.log("Signaling connected:", socket.id);

  socket.on("disconnect", (reason) => {
    console.log("Signaling disconnected:", reason);
  });

  function onIncomingCall(handler) {
    socket.on("incoming-call", handler);
  }

  function onIceCandidate(handler) {
    socket.on("ice-candidate", handler);
  }

  function onPeerEndedCall(handler) {
    socket.on("peer-ended-call", handler);
  }

  return {
    socket,
    emit: socket.emit.bind(socket),
    onIncomingCall,
    onIceCandidate,
    onPeerEndedCall
  };
}

module.exports = { createSignalingClient };
