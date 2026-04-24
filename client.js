const WebSocket = require("ws");
const https = require("https");
const http = require("http");

const TUNNEL_URL =
  "wss://reverse-ws-gateway2-0af9f160c1-test.apps.ir-central1.arvancaas.ir/__tunnel";

const LOCAL_XHTTP_HOST = "127.0.0.1";
const LOCAL_XHTTP_PORT = 10000;

let reconnectTimer = null;
let ws = null;
let retryDelay = 3000;

const xhttpRequests = new Map();

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

function closeXhttpRequest(id, reason = "closed") {
  const item = xhttpRequests.get(id);

  if (item) {
    xhttpRequests.delete(id);

    try {
      if (item.req && !item.req.destroyed) item.req.destroy();
    } catch {}
  }

  sendWs({
    type: "xhttp_close",
    id,
  });

  console.log("closed local XHTTP request:", id, reason);
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

    if (msg.type === "xhttp_open") {
      const headers = { ...(msg.headers || {}) };
      headers.host = `${LOCAL_XHTTP_HOST}:${LOCAL_XHTTP_PORT}`;
      delete headers.connection;
      delete headers["content-length"];

      const req = http.request(
        {
          hostname: LOCAL_XHTTP_HOST,
          port: LOCAL_XHTTP_PORT,
          path: msg.url,
          method: msg.method,
          headers,
        },
        (res) => {
          sendWs({
            type: "xhttp_response_start",
            id: msg.id,
            statusCode: res.statusCode,
            headers: res.headers,
          });

          res.on("data", (chunk) => {
            sendWs({
              type: "xhttp_response_data",
              id: msg.id,
              data: chunk.toString("base64"),
            });
          });

          res.on("end", () => {
            sendWs({
              type: "xhttp_response_end",
              id: msg.id,
            });
            xhttpRequests.delete(msg.id);
          });

          res.on("close", () => {
            if (xhttpRequests.has(msg.id)) {
              closeXhttpRequest(msg.id, "local xhttp response closed");
            }
          });
        },
      );

      xhttpRequests.set(msg.id, { req });

      req.on("error", (err) => {
        console.error("local xhttp request error:", msg.id, err.message);
        closeXhttpRequest(msg.id, err.message);
      });

      req.on("close", () => {
        if (xhttpRequests.has(msg.id)) {
          closeXhttpRequest(msg.id, "local xhttp request closed");
        }
      });

      return;
    }

    if (msg.type === "xhttp_data") {
      const item = xhttpRequests.get(msg.id);

      if (!item || !item.req || item.req.destroyed) {
        xhttpRequests.delete(msg.id);
        sendWs({
          type: "xhttp_close",
          id: msg.id,
        });
        return;
      }

      try {
        item.req.write(Buffer.from(msg.data || "", "base64"));
      } catch (err) {
        closeXhttpRequest(msg.id, err.message);
      }

      return;
    }

    if (msg.type === "xhttp_end") {
      const item = xhttpRequests.get(msg.id);
      if (!item || !item.req || item.req.destroyed) return;

      try {
        item.req.end();
      } catch (err) {
        closeXhttpRequest(msg.id, err.message);
      }

      return;
    }

    if (msg.type === "xhttp_close") {
      closeXhttpRequest(msg.id, "remote close");
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

    for (const id of xhttpRequests.keys()) {
      closeXhttpRequest(id, "control tunnel closed");
    }

    xhttpRequests.clear();
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("control websocket error:", err.message);
  });
}

connect();