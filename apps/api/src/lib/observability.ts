import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import client from "prom-client";
import { env, isProd } from "../env";

/**
 * Observability (Phase 1.8): structured JSON logs with request ids, an error-reporting
 * hook (Sentry-ready without a hard dependency), and Prometheus metrics.
 */

/** Never log secrets or personal data. */
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "*.password",
  "*.pin",
  "*.otp",
  "*.code",
  "*.aadhaar",
  "*.accessToken",
  "*.refreshToken",
  "*.token",
];

export const createLogger = (destination?: pino.DestinationStream) =>
  pino(
    {
      level: env.LOG_LEVEL,
      base: { service: "canavo-api" },
      redact: { paths: REDACT, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );

export const logger = createLogger();

const REQ_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** X-Request-Id in and out (trusted when well-formed, otherwise generated). */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  req.id = incoming && REQ_ID_RE.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

/** JSON access log line per request (production, or LOG_FORMAT=json). */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  serializers: {
    req: (r: { id: string; method: string; url: string }) => ({ id: r.id, method: r.method, url: r.url.split("?")[0] }),
    res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/ready" || req.url === "/metrics" },
});

// ---------------------------------------------------------------------------
// Error reporting hook
// ---------------------------------------------------------------------------
export type ErrorReporter = (err: unknown, context: Record<string, unknown>) => void;
let reporter: ErrorReporter | null = null;

/** Plug an error tracker (e.g. Sentry: setErrorReporter((e, ctx) => Sentry.captureException(e, { extra: ctx }))). */
export function setErrorReporter(fn: ErrorReporter | null) {
  reporter = fn;
}

export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  logger.error({ err, ...context }, err instanceof Error ? err.message : "error");
  errorsTotal.inc({ kind: String(context.kind ?? "request") });
  try {
    reporter?.(err, context);
  } catch (e) {
    logger.warn({ err: e }, "error reporter failed");
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "canavo_" });

const httpDuration = new client.Histogram({
  name: "canavo_http_request_duration_seconds",
  help: "HTTP request duration by method, route and status",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
export const errorsTotal = new client.Counter({ name: "canavo_errors_total", help: "Errors reported", labelNames: ["kind"], registers: [registry] });
export const jobRuns = new client.Counter({ name: "canavo_job_runs_total", help: "Background job runs", labelNames: ["job", "result"], registers: [registry] });

/** Time every request; the route label is the matched pattern (no ids → bounded cardinality). */
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

/** GET /metrics — Prometheus text. Production requires METRICS_TOKEN (Bearer). */
export async function metricsEndpoint(req: Request, res: Response) {
  if (isProd || env.METRICS_TOKEN) {
    if (!env.METRICS_TOKEN || req.header("authorization") !== `Bearer ${env.METRICS_TOKEN}`) return res.status(404).end();
  }
  res.setHeader("content-type", registry.contentType);
  res.end(await registry.metrics());
}

/** Register gauges whose value is read at scrape time (e.g. outbox backlog). */
export function gauge(name: string, help: string, collect: () => Promise<number>) {
  new client.Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      this.set(await collect().catch(() => -1));
    },
  });
}

/** Log and report crashes; an uncaught exception leaves the process in an unknown state → exit. */
export function installProcessHandlers() {
  process.on("unhandledRejection", (reason) => reportError(reason, { kind: "unhandledRejection" }));
  process.on("uncaughtException", (err) => {
    reportError(err, { kind: "uncaughtException" });
    setTimeout(() => process.exit(1), 200).unref();
  });
}
