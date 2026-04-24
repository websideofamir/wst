const WebSocket = require("ws");
const https = require("https");
const net = require("net");

const TUNNEL_URL =
  "wss://reverse-ws-gateway2-0af9f160c1-test.apps.ir-central1.arvancaas.ir/__tunnel";

let reconnectTimer = null;
let ws = null;

const tcpStreams = new Map();

let retryDelay = 300;

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();

    // grow delay gradually (max 5s)
    retryDelay = Math.min(retryDelay + 150, 5000);
  }, retryDelay);
}

function sendWs(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function connect() {
  ws = new WebSocket(TUNNEL_URL);

  ws.on("open", () => {
    console.log("connected to PaaS reverse tunnel:", TUNNEL_URL);
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "http_request") {
      const body = Buffer.from(msg.body || "", "base64");

      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: 443,
          path: msg.url,
          method: msg.method,
          headers: {
            ...msg.headers,
            host: "127.0.0.1",
          },
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks = [];

          res.on("data", (chunk) => chunks.push(chunk));

          res.on("end", () => {
            sendWs({
              type: "http_response",
              id: msg.id,
              statusCode: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("base64"),
            });
          });
        },
      );

      req.on("error", (err) => {
        sendWs({
          type: "http_response",
          id: msg.id,
          statusCode: 502,
          headers: {
            "content-type": "text/plain",
          },
          body: Buffer.from(err.message).toString("base64"),
        });
      });

      req.end(body);
      return;
    }

    if (msg.type === "stream_open") {
      const socket = net.connect({
        host: msg.targetHost || "127.0.0.1",
        port: msg.targetPort || 10000,
      });

      tcpStreams.set(msg.id, socket);

      socket.on("connect", () => {
        console.log("opened stream to Xray:", msg.id);

        if (msg.initial) {
          socket.write(Buffer.from(msg.initial, "base64"));
        }
      });

      socket.on("data", (chunk) => {
        sendWs({
          type: "stream_data",
          id: msg.id,
          data: chunk.toString("base64"),
        });
      });

      socket.on("close", () => {
        tcpStreams.delete(msg.id);
        sendWs({
          type: "stream_close",
          id: msg.id,
        });
      });

      socket.on("error", (err) => {
        console.error("xray stream error:", id, err.message);
        streams.delete(id);
        sendTunnelMessage({
          type: "stream_close",
          id,
        });
      });

      return;
    }

    if (msg.type === "stream_data") {
      const socket = streams.get(msg.id);
      if (!socket || socket.destroyed || !socket.writable) {
        streams.delete(msg.id);
        sendTunnelMessage({
          type: "stream_close",
          id: msg.id,
        });
        return;
      }

      socket.write(Buffer.from(msg.data || "", "base64"), (err) => {
        if (err) {
          console.error("xray stream write error:", msg.id, err.message);
          streams.delete(msg.id);
          socket.destroy();
          sendTunnelMessage({
            type: "stream_close",
            id: msg.id,
          });
        }
      });

      return;
    }

    if (msg.type === "stream_close") {
      const socket = tcpStreams.get(msg.id);
      if (!socket) return;

      tcpStreams.delete(msg.id);
      socket.destroy();
      return;
    }
  });

  ws.on("close", (code, reason) => {
    console.log(
      "control tunnel closed:",
      "code=",
      code,
      "reason=",
      reason.toString() || "(empty)",
      "reconnecting...",
    );

    for (const socket of tcpStreams.values()) {
      socket.destroy();
    }

    tcpStreams.clear();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("control websocket error:", err.message);
  });
}

connect();
