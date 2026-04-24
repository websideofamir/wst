const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = 8080;
const CONTROL_PATH = "/__tunnel";
const XRAY_PATH = "/__xray";

let tunnel = null;
let tunnelConnectedAt = null;

const pendingHttp = new Map();
const streams = new Map();

function iranTimestamp() {
  const now = new Date();
  const iranTime = new Date(now.getTime() + 3.5 * 60 * 60 * 1000);
  return iranTime.toISOString().replace("T", " ").replace("Z", " GMT+03:30");
}

function log(...args) {
  console.log(`[${iranTimestamp()}]`, ...args);
}

function logError(...args) {
  console.error(`[${iranTimestamp()}]`, ...args);
}

function isTunnelConnected() {
  return tunnel && tunnel.readyState === tunnel.OPEN;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendTunnelMessage(msg) {
  if (!isTunnelConnected()) return false;
  tunnel.send(JSON.stringify(msg));
  return true;
}

function buildRawHttpUpgradeRequest(req, head) {
  const lines = [];

  lines.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`);

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${key}: ${item}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push("");
  lines.push("");

  return Buffer.concat([
    Buffer.from(lines.join("\r\n")),
    head || Buffer.alloc(0),
  ]);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  log("incoming request:", req.method, req.url, "pathname:", pathname);

  if (pathname === "/k8s-healthz") {
    sendJson(res, 200, {
      status: "ok",
      source: "kubernetes",
      service: "running",
    });
    return;
  }

  if (pathname === "/__gateway/healthz") {
    sendJson(res, 200, {
      status: "ok",
      source: "manual",
      service: "running",
      uptimeSeconds: Math.floor(process.uptime()),
    });
    return;
  }

  if (pathname === "/__gateway/tunnel-healthz") {
    const connected = isTunnelConnected();

    sendJson(res, 200, {
      status: connected ? "ok" : "error",
      source: "manual",
      tunnel: connected ? "connected" : "disconnected",
      connected,
      connectedAt: tunnelConnectedAt,
      activeStreams: streams.size,
      pendingHttpRequests: pendingHttp.size,
    });
    return;
  }

  if (pathname === "/__gateway/routes") {
    sendJson(res, 200, {
      routes: [
        "/k8s-healthz",
        "/__gateway/healthz",
        "/__gateway/tunnel-healthz",
        "/__gateway/routes",
        "/__tunnel",
        "/__xray",
      ],
    });
    return;
  }

  if (!isTunnelConnected()) {
    res.writeHead(502, {
      "content-type": "text/plain",
    });
    res.end("reverse tunnel is not connected");
    return;
  }

  const chunks = [];

  req.on("data", (chunk) => chunks.push(chunk));

  req.on("end", () => {
    const id = crypto.randomUUID();
    pendingHttp.set(id, res);

    sendTunnelMessage({
      type: "http_request",
      id,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("base64"),
    });

    setTimeout(() => {
      if (pendingHttp.has(id)) {
        pendingHttp.delete(id);

        res.writeHead(504, {
          "content-type": "text/plain",
        });

        res.end("upstream timeout");
      }
    }, 30000);
  });
});

const controlWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  log("upgrade request:", pathname);

  if (pathname === CONTROL_PATH) {
    controlWss.handleUpgrade(req, socket, head, (ws) => {
      controlWss.emit("connection", ws, req);
    });
    return;
  }

  if (pathname === XRAY_PATH) {
    if (!isTunnelConnected()) {
      socket.write(
        "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nreverse tunnel is not connected",
      );
      socket.destroy();
      return;
    }

    const id = crypto.randomUUID();
    streams.set(id, socket);

    log("xray stream opened:", id);

    const initial = buildRawHttpUpgradeRequest(req, head);

    sendTunnelMessage({
      type: "stream_open",
      id,
      targetHost: "127.0.0.1",
      targetPort: 10000,
      initial: initial.toString("base64"),
    });

    socket.on("data", (chunk) => {
      sendTunnelMessage({
        type: "stream_data",
        id,
        data: chunk.toString("base64"),
      });
    });

    socket.on("close", () => {
      streams.delete(id);
      log("xray stream closed:", id);
      sendTunnelMessage({
        type: "stream_close",
        id,
      });
    });

    socket.on("error", (err) => {
      streams.delete(id);
      logError("xray stream error:", id, err.message);
      sendTunnelMessage({
        type: "stream_close",
        id,
      });
    });

    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

controlWss.on("connection", (ws) => {
  if (isTunnelConnected()) {
    console.log("replacing existing control tunnel");

    try {
      tunnel.close(1000, "replaced by new tunnel");
    } catch {}

    for (const socket of streams.values()) {
      socket.destroy();
    }

    streams.clear();
  }

  tunnel = ws;
  tunnelConnectedAt = iranTimestamp();

  log("reverse control tunnel connected");

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "http_response") {
      const res = pendingHttp.get(msg.id);
      if (!res) return;

      pendingHttp.delete(msg.id);

      res.writeHead(msg.statusCode || 502, msg.headers || {});
      res.end(Buffer.from(msg.body || "", "base64"));
      return;
    }

    if (msg.type === "stream_data") {
      const socket = streams.get(msg.id);
      if (!socket) return;

      socket.write(Buffer.from(msg.data || "", "base64"));
      return;
    }

    if (msg.type === "stream_close") {
      const socket = streams.get(msg.id);
      if (!socket) return;

      streams.delete(msg.id);
      socket.destroy();
      return;
    }
  });

  ws.on("close", () => {
    log("reverse control tunnel disconnected");

    if (tunnel === ws) {
      tunnel = null;
      tunnelConnectedAt = null;
    }

    for (const socket of streams.values()) {
      socket.destroy();
    }

    streams.clear();
  });

  ws.on("error", (err) => {
    logError("control websocket error:", err.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log("gateway listening on 8080");
});
