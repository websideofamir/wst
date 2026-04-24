const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = 8080;
const CONTROL_PATH = "/__tunnel";
const XHTTP_PATH = "/assets/xhttp";

let tunnel = null;
let tunnelConnectedAt = null;

const pendingHttp = new Map();
const xhttpStreams = new Map();

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

  try {
    tunnel.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    logError("failed to send tunnel message:", err.message);
    return false;
  }
}

function closeXhttpStream(id, reason = "closed") {
  const stream = xhttpStreams.get(id);

  if (stream) {
    xhttpStreams.delete(id);

    try {
      if (stream.req && !stream.req.destroyed) stream.req.destroy();
    } catch {}

    try {
      if (stream.res && !stream.res.destroyed) stream.res.destroy();
    } catch {}
  }

  sendTunnelMessage({
    type: "xhttp_close",
    id,
  });

  log("xhttp stream closed:", id, reason);
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
      activeXhttpStreams: xhttpStreams.size,
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
        CONTROL_PATH,
        XHTTP_PATH,
      ],
    });
    return;
  }

  if (pathname === XHTTP_PATH || pathname.startsWith(XHTTP_PATH + "/")) {
    if (!isTunnelConnected()) {
      res.writeHead(502, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      res.end("reverse tunnel is not connected");
      return;
    }

    const id = crypto.randomUUID();

    xhttpStreams.set(id, {
      req,
      res,
      responseStarted: false,
    });

    log("xhttp request opened:", id, req.method, req.url);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];

    const opened = sendTunnelMessage({
      type: "xhttp_open",
      id,
      method: req.method,
      url: req.url,
      headers,
    });

    if (!opened) {
      closeXhttpStream(id, "failed to send xhttp_open");
      return;
    }

    req.on("data", (chunk) => {
      const ok = sendTunnelMessage({
        type: "xhttp_data",
        id,
        data: chunk.toString("base64"),
      });

      if (!ok) {
        closeXhttpStream(id, "failed to send xhttp_data");
      }
    });

    req.on("end", () => {
      sendTunnelMessage({
        type: "xhttp_end",
        id,
      });
    });

    req.on("close", () => {
      const stream = xhttpStreams.get(id);
      if (stream && !stream.responseStarted) {
        closeXhttpStream(id, "client request closed before response");
      }
    });

    req.on("error", (err) => {
      closeXhttpStream(id, err.message);
    });

    res.on("close", () => {
      if (xhttpStreams.has(id)) {
        closeXhttpStream(id, "client response closed");
      }
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

  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

controlWss.on("connection", (ws) => {
  if (isTunnelConnected()) {
    log("replacing existing control tunnel");

    try {
      tunnel.close(1000, "replaced by new tunnel");
    } catch {}

    for (const id of xhttpStreams.keys()) {
      closeXhttpStream(id, "control tunnel replaced");
    }

    xhttpStreams.clear();
  }

  tunnel = ws;
  tunnelConnectedAt = iranTimestamp();

  log("reverse control tunnel connected");

  ws.on("message", (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logError("invalid tunnel message:", err.message);
      return;
    }

    if (msg.type === "http_response") {
      const res = pendingHttp.get(msg.id);
      if (!res) return;

      pendingHttp.delete(msg.id);

      res.writeHead(msg.statusCode || 502, msg.headers || {});
      res.end(Buffer.from(msg.body || "", "base64"));
      return;
    }

    if (msg.type === "xhttp_response_start") {
      const stream = xhttpStreams.get(msg.id);
      if (!stream || stream.res.destroyed) return;

      stream.responseStarted = true;

      const headers = msg.headers || {};
      delete headers.connection;
      delete headers["transfer-encoding"];

      stream.res.writeHead(msg.statusCode || 200, headers);
      return;
    }

    if (msg.type === "xhttp_response_data") {
      const stream = xhttpStreams.get(msg.id);
      if (!stream || stream.res.destroyed) {
        xhttpStreams.delete(msg.id);
        sendTunnelMessage({
          type: "xhttp_close",
          id: msg.id,
        });
        return;
      }

      const chunk = Buffer.from(msg.data || "", "base64");

      try {
        stream.res.write(chunk);
      } catch (err) {
        closeXhttpStream(msg.id, err.message);
      }

      return;
    }

    if (msg.type === "xhttp_response_end") {
      const stream = xhttpStreams.get(msg.id);
      if (!stream) return;

      xhttpStreams.delete(msg.id);

      try {
        stream.res.end();
      } catch {}

      log("xhttp response ended:", msg.id);
      return;
    }

    if (msg.type === "xhttp_close") {
      closeXhttpStream(msg.id, "remote close");
      return;
    }
  });

  ws.on("close", (code, reason) => {
    log(
      "reverse control tunnel disconnected:",
      "code=",
      code,
      "reason=",
      reason.toString() || "(empty)",
    );

    if (tunnel === ws) {
      tunnel = null;
      tunnelConnectedAt = null;
    }

    for (const id of xhttpStreams.keys()) {
      closeXhttpStream(id, "control tunnel disconnected");
    }

    xhttpStreams.clear();
  });

  ws.on("error", (err) => {
    logError("control websocket error:", err.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log("gateway listening on 8080");
});
