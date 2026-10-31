#!/usr/bin/env node
/**
 * CANAVO single-port gateway — lets one public URL (ngrok, a LAN IP, a domain)
 * serve the whole app:
 *
 *   /api/*        → API  (prefix stripped)     http://localhost:4000
 *   /socket.io/*  → API  (live updates, incl. WebSocket upgrades)
 *   everything else → web app                  http://127.0.0.1:3100 (internal)
 *
 * Usage: node scripts/gateway.mjs   (GATEWAY_PORTS="8080,3001", API_TARGET, WEB_TARGET env vars optional)
 * Build the web app with NEXT_PUBLIC_API_URL=/api so the browser calls the same origin.
 */
import http from "node:http";
import net from "node:net";

// One or more public ports (comma-separated): 8080 for ngrok / LAN, 3001 so the old address keeps working.
const PORTS = String(process.env.GATEWAY_PORTS ?? process.env.GATEWAY_PORT ?? "8080,3001").split(",").map((p) => Number(p.trim())).filter(Boolean);
const API = new URL(process.env.API_TARGET ?? "http://localhost:4000");
const WEB = new URL(process.env.WEB_TARGET ?? "http://127.0.0.1:3100");

function route(url = "/") {
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) return { target: API, path: url.slice(4) || "/" };
  if (url.startsWith("/socket.io")) return { target: API, path: url };
  return { target: WEB, path: url };
}

function forwardedHeaders(req) {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  // Append (don't replace) so the client IP reported by ngrok is preserved for rate limiting.
  const prior = req.headers["x-forwarded-for"];
  const xff = [prior, req.socket.remoteAddress].filter(Boolean).join(", ");
  return { ...req.headers, "x-forwarded-proto": proto, "x-forwarded-host": host, "x-forwarded-for": xff };
}

const server = http.createServer((req, res) => {
  const { target, path } = route(req.url);
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, method: req.method, path, headers: { ...forwardedHeaders(req), host: target.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`CANAVO gateway: ${target === API ? "API" : "web app"} is not reachable (${e.code ?? e.message})`);
  });
  req.pipe(upstream);
});

// WebSocket upgrades (socket.io, Next.js dev HMR) — pipe the raw TCP stream.
server.on("upgrade", (req, socket, head) => {
  const { target, path } = route(req.url);
  const up = net.connect(Number(target.port), target.hostname, () => {
    const headers = { ...forwardedHeaders(req), host: target.host };
    const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]))];
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    socket.destroy();
    up.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
});

for (const port of PORTS) {
  // Each port gets its own listener sharing the same handlers.
  const listener = port === PORTS[0] ? server : http.createServer(server.listeners("request")[0]);
  if (listener !== server) listener.on("upgrade", server.listeners("upgrade")[0]);
  listener.on("error", (e) => console.error(`CANAVO gateway: port ${port} unavailable (${e.code ?? e.message})`));
  listener.listen(port, () => console.info(`CANAVO gateway on http://localhost:${port}  (api → ${API.origin}, web → ${WEB.origin})`));
}
