const http = require("http");
const https = require("https");

const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 16
});

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 16
});

function getOpenAIHttpAgent() {
  return sharedHttpsAgent;
}

function getAxiosAgents() {
  return {
    httpAgent: sharedHttpAgent,
    httpsAgent: sharedHttpsAgent
  };
}

module.exports = {
  getOpenAIHttpAgent,
  getAxiosAgents
};
