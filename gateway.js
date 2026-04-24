const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = 8080;
const CONTROL_PATH = "/__tunnel";
const XRAY_PATH = "/assets/ws";

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

  try {
    tunnel.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    logError("failed to send tunnel message:", err.message);
    return false;
  }
}

function closeStream(id, reason = "closed") {
  const ws = streams.get(id);

  if (ws) {
    streams.delete(id);

    try {
      ws.close();
    } catch {}
  }

  sendTunnelMessage({
    type: "xray_ws_close",
    id,
  });

  log("xray websocket closed:", id, reason);
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
        CONTROL_PATH,
        XRAY_PATH,
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
const xrayWss = new WebSocketServer({ noServer: true });

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

    xrayWss.handleUpgrade(req, socket, head, (ws) => {
      xrayWss.emit("connection", ws, req);
    });
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
});

xrayWss.on("connection", (clientWs) => {
  const id = crypto.randomUUID();

  streams.set(id, clientWs);
  log("xray websocket opened:", id);

  sendTunnelMessage({
    type: "xray_ws_open",
    id,
  });

  clientWs.on("message", (data, isBinary) => {
    const ok = sendTunnelMessage({
      type: "xray_ws_data",
      id,
      data: Buffer.from(data).toString("base64"),
      binary: isBinary,
    });

    if (!ok) {
      closeStream(id, "failed to send xray_ws_data");
    }
  });

  clientWs.on("close", (code, reason) => {
    if (streams.has(id)) {
      streams.delete(id);

      log(
        "xray websocket closed:",
        id,
        "code=",
        code,
        "reason=",
        reason.toString() || "(empty)",
      );

      sendTunnelMessage({
        type: "xray_ws_close",
        id,
      });
    }
  });

  clientWs.on("error", (err) => {
    logError("xray websocket error:", id, err.message);
    closeStream(id, err.message);
  });
});

controlWss.on("connection", (ws) => {
  if (isTunnelConnected()) {
    log("replacing existing control tunnel");

    try {
      tunnel.close(1000, "replaced by new tunnel");
    } catch {}

    for (const stream of streams.values()) {
      try {
        stream.close();
      } catch {}
    }

    streams.clear();
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

    if (msg.type === "xray_ws_data") {
      const clientWs = streams.get(msg.id);

      if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
        streams.delete(msg.id);
        sendTunnelMessage({
          type: "xray_ws_close",
          id: msg.id,
        });
        return;
      }

      try {
        clientWs.send(Buffer.from(msg.data || "", "base64"), {
          binary: msg.binary !== false,
        });
      } catch (err) {
        logError("xray websocket send error:", msg.id, err.message);
        closeStream(msg.id, err.message);
      }

      return;
    }

    if (msg.type === "xray_ws_close") {
      const clientWs = streams.get(msg.id);
      if (!clientWs) return;

      streams.delete(msg.id);

      try {
        clientWs.close();
      } catch {}

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

    for (const stream of streams.values()) {
      try {
        stream.close();
      } catch {}
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
