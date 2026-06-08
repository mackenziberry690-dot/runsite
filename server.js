const http = require("node:http");
const https = require("node:https");

const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const PUBLIC_RELAY_PATH = normalizeRelayPath(process.env.PUBLIC_RELAY_PATH || "/api");
const RELAY_PATH = normalizeRelayPath(process.env.RELAY_PATH || "/api");
const RELAY_KEY = (process.env.RELAY_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = parsePositiveInt(process.env.UPSTREAM_TIMEOUT_MS, 0, 1000);
const MAX_INFLIGHT = parsePositiveInt(process.env.MAX_INFLIGHT, 512, 1);
const LISTEN_PORT = parsePort(process.env.PORT, 3000);
const LISTEN_HOST = (process.env.BIND_HOST || "0.0.0.0").trim() || "0.0.0.0";

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

const FORWARD_HEADER_EXACT = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-length",
  "content-type",
  "pragma",
  "range",
  "referer",
  "user-agent",
]);

const FORWARD_HEADER_PREFIXES = ["sec-ch-", "sec-fetch-"];

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "via",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-for",
  "x-real-ip",
]);

let inFlight = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/__debug") {
    return sendJson(res, 200, {
      TARGET_BASE,
      PUBLIC_RELAY_PATH,
      RELAY_PATH,
      RELAY_KEY_SET: !!RELAY_KEY,
      UPSTREAM_TIMEOUT_MS,
      MAX_INFLIGHT,
      LISTEN_HOST,
      LISTEN_PORT,
      inFlight,
    });
  }

  if (!TARGET_BASE) return sendText(res, 500, "Misconfigured: TARGET_DOMAIN is not set");
  if (!RELAY_PATH) return sendText(res, 500, "Misconfigured: RELAY_PATH is not set");
  if (RELAY_PATH === "/") return sendText(res, 500, "Misconfigured: RELAY_PATH cannot be '/'");
  if (!PUBLIC_RELAY_PATH) {
    return sendText(res, 500, "Misconfigured: PUBLIC_RELAY_PATH is not set");
  }
  if (PUBLIC_RELAY_PATH === "/") {
    return sendText(res, 500, "Misconfigured: PUBLIC_RELAY_PATH cannot be '/'");
  }
  if (RELAY_KEY && RELAY_KEY.length < 16) {
    return sendText(res, 500, "Misconfigured: RELAY_KEY is too short");
  }

  const normalizedPath = normalizeIncomingPath(url.pathname);
  if (!isAllowedRelayPath(normalizedPath, PUBLIC_RELAY_PATH)) {
    return sendText(res, 404, "Not Found");
  }

  if (!ALLOWED_METHODS.has(req.method || "")) {
    return sendText(res, 405, "Method Not Allowed", { allow: "GET, HEAD, POST" });
  }

  if (RELAY_KEY) {
    const token = String(req.headers["x-relay-key"] || "");
    if (token !== RELAY_KEY) return sendText(res, 403, "Forbidden");
  }

  if (inFlight >= MAX_INFLIGHT) {
    return sendText(res, 503, "Server Busy: Too Many Inflight Requests", {
      "retry-after": "1",
    });
  }
  inFlight++;

  try {
    const upstreamPath = mapPublicPathToRelayPath(
      normalizedPath,
      PUBLIC_RELAY_PATH,
      RELAY_PATH,
    );
    const targetUrl = `${TARGET_BASE}${upstreamPath}${url.search || ""}`;
    const forwardHeaders = buildForwardHeaders(req);

    await proxyToUpstream(req, res, targetUrl, forwardHeaders);
  } catch (err) {
    if (res.headersSent) {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (err && err.name === "AbortError") {
      return sendText(res, 504, "Gateway Timeout: Upstream Timeout");
    }
    return sendText(res, 502, "Bad Gateway: " + String(err));
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Relay listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
});

function sendText(res, status, body, headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, headers);
  return res.end(body);
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  return res.end(json);
}

function buildForwardHeaders(req) {
  const headers = new Headers();

  for (const [key, rawValue] of Object.entries(req.headers)) {
    if (rawValue === undefined) continue;

    const lower = key.toLowerCase();
    if (STRIP_HEADERS.has(lower)) continue;
    if (lower === "x-relay-key") continue;
    if (!shouldForwardHeader(lower)) continue;

    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    headers.set(key, value);
  }

  const clientIp = req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "";
  if (clientIp) {
    headers.set("x-forwarded-for", Array.isArray(clientIp) ? clientIp.join(", ") : String(clientIp));
  }

  return headers;
}

function proxyToUpstream(req, res, targetUrl, forwardHeaders) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(targetUrl);
    const transport = upstreamUrl.protocol === "https:" ? https : http;
    if (upstreamUrl.protocol !== "https:" && upstreamUrl.protocol !== "http:") {
      reject(new Error(`Unsupported upstream protocol: ${upstreamUrl.protocol}`));
      return;
    }

    let timeoutRef;
    let settled = false;
    let upstreamReq;
    let upstreamRes;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timeoutRef !== undefined) clearTimeout(timeoutRef);
      cleanup();
      if (err) reject(err);
      else resolve();
    };

    const onClientClose = () => {
      if (!res.writableEnded) {
        if (upstreamReq) upstreamReq.destroy();
        if (upstreamRes) upstreamRes.destroy();
      }
      finish();
    };

    const cleanup = () => {
      req.off("error", finish);
      res.off("error", finish);
      res.off("finish", finish);
      res.off("close", onClientClose);
      if (upstreamReq) upstreamReq.off("error", finish);
      if (upstreamRes) {
        upstreamRes.off("error", finish);
        upstreamRes.off("end", finish);
      }
    };

    const requestOptions = {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || undefined,
      method: req.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: headersToObject(forwardHeaders),
    };

    upstreamReq = transport.request(requestOptions, (response) => {
      upstreamRes = response;
      res.statusCode = response.statusCode || 502;

      for (const [key, value] of Object.entries(response.headers)) {
        const lower = key.toLowerCase();
        if (lower === "transfer-encoding" || lower === "connection") continue;
        if (value === undefined) continue;
        try {
          res.setHeader(key, value);
        } catch {
          // Skip headers rejected by Node's HTTP implementation.
        }
      }

      response.on("error", finish);
      response.on("end", finish);
      response.pipe(res);
    });

    req.on("error", finish);
    res.on("error", finish);
    res.on("finish", finish);
    res.on("close", onClientClose);
    upstreamReq.on("error", finish);

    if (UPSTREAM_TIMEOUT_MS > 0) {
      timeoutRef = setTimeout(() => {
        const err = new Error("Upstream Timeout");
        err.name = "AbortError";
        upstreamReq.destroy(err);
      }, UPSTREAM_TIMEOUT_MS);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      upstreamReq.end();
    } else {
      req.pipe(upstreamReq);
    }
  });
}

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

function shouldForwardHeader(name) {
  if (FORWARD_HEADER_EXACT.has(name)) return true;
  for (const prefix of FORWARD_HEADER_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function isAllowedRelayPath(pathname, publicPath) {
  return pathname === publicPath || pathname.startsWith(`${publicPath}/`);
}

function mapPublicPathToRelayPath(pathname, publicPath, relayPath) {
  if (pathname === publicPath) return relayPath;
  return `${relayPath}${pathname.slice(publicPath.length)}`;
}

function normalizeRelayPath(rawPath) {
  if (!rawPath) return "";
  const p = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function normalizeIncomingPath(pathname) {
  if (!pathname) return "/";
  let p = pathname.replace(/\/{2,}/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function parsePositiveInt(raw, fallback, min) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) return fallback;
  return Math.trunc(v);
}

function parsePort(raw, fallback) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 1 || v > 65535) return fallback;
  return Math.trunc(v);
}
