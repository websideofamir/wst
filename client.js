const WebSocket = require("ws");
const https = require("https");

const TUNNEL_URL =
  "wss://reverse-ws-gateway2-0af9f160c1-test.apps.ir-central1.arvancaas.ir/__tunnel";
const LOCAL_XRAY_WS_URL = "ws://127.0.0.1:10000/assets/ws";

let reconnectTimer = null;
let ws = null;
let retryDelay = 3000;

const xrayStreams = new Map();

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();

    retryDelay = Math.min(retryDelay + 1000, 10000);
  }, retryDelay);
}

function sendWs(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    console.error("failed to send ws message:", err.message);
    return false;
  }
}

function closeXrayStream(id, reason = "closed") {
  const localWs = xrayStreams.get(id);

  if (localWs) {
    xrayStreams.delete(id);

    try {
      localWs.close();
    } catch {}
  }

  sendWs({
    type: "xray_ws_close",
    id,
  });

  console.log("closed local Xray websocket:", id, reason);
}

function connect() {
  ws = new WebSocket(TUNNEL_URL);

  ws.on("open", () => {
    retryDelay = 3000;
    console.log("connected to PaaS reverse tunnel:", TUNNEL_URL);
  });

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error("invalid tunnel message:", err.message);
      return;
    }

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

    if (msg.type === "xray_ws_open") {
      const localWs = new WebSocket(LOCAL_XRAY_WS_URL);

      xrayStreams.set(msg.id, localWs);

      localWs.on("open", () => {
        console.log("opened websocket to local Xray:", msg.id);
      });

      localWs.on("message", (data, isBinary) => {
        const ok = sendWs({
          type: "xray_ws_data",
          id: msg.id,
          data: Buffer.from(data).toString("base64"),
          binary: isBinary,
        });

        if (!ok) {
          closeXrayStream(msg.id, "failed to send xray_ws_data");
        }
      });

      localWs.on("close", (code, reason) => {
        if (xrayStreams.has(msg.id)) {
          xrayStreams.delete(msg.id);

          console.log(
            "local Xray websocket closed:",
            msg.id,
            "code=",
            code,
            "reason=",
            reason.toString() || "(empty)",
          );

          sendWs({
            type: "xray_ws_close",
            id: msg.id,
          });
        }
      });

      localWs.on("error", (err) => {
        console.error("local Xray websocket error:", msg.id, err.message);
        closeXrayStream(msg.id, err.message);
      });

      return;
    }

    if (msg.type === "xray_ws_data") {
      const localWs = xrayStreams.get(msg.id);

      if (!localWs || localWs.readyState !== WebSocket.OPEN) {
        xrayStreams.delete(msg.id);

        sendWs({
          type: "xray_ws_close",
          id: msg.id,
        });

        return;
      }

      try {
        localWs.send(Buffer.from(msg.data || "", "base64"), {
          binary: msg.binary !== false,
        });
      } catch (err) {
        console.error("local Xray websocket send error:", msg.id, err.message);
        closeXrayStream(msg.id, err.message);
      }

      return;
    }

    if (msg.type === "xray_ws_close") {
      const localWs = xrayStreams.get(msg.id);
      if (!localWs) return;

      xrayStreams.delete(msg.id);

      try {
        localWs.close();
      } catch {}

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

    for (const localWs of xrayStreams.values()) {
      try {
        localWs.close();
      } catch {}
    }

    xrayStreams.clear();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("control websocket error:", err.message);
  });
}

connect();
