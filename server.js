const http = require("node:http");
const { Readable } = require("node:stream");

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

  const abortCtrl = new AbortController();
  let timeoutRef;

  try {
    const upstreamPath = mapPublicPathToRelayPath(
      normalizedPath,
      PUBLIC_RELAY_PATH,
      RELAY_PATH,
    );
    const targetUrl = `${TARGET_BASE}${upstreamPath}${url.search || ""}`;
    const forwardHeaders = buildForwardHeaders(req);

    if (UPSTREAM_TIMEOUT_MS > 0) {
      timeoutRef = setTimeout(() => abortCtrl.abort(), UPSTREAM_TIMEOUT_MS);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const fetchOpts = {
      method: req.method,
      headers: forwardHeaders,
      redirect: "manual",
      signal: abortCtrl.signal,
    };

    if (hasBody) {
      fetchOpts.body = req;
      fetchOpts.duplex = "half";
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    res.statusCode = upstream.status;
    for (const [key, value] of upstream.headers.entries()) {
      const lower = key.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection") continue;
      try {
        res.setHeader(key, value);
      } catch {
        // Skip headers rejected by Node's HTTP implementation.
      }
    }

    if (!upstream.body) {
      return res.end();
    }

    Readable.fromWeb(upstream.body).pipe(res);
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
    if (timeoutRef !== undefined) clearTimeout(timeoutRef);
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
