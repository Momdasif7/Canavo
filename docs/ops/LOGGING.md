# Logging and error tracking

## What is logged
- **Format:** pino JSON (`service: "canavo-api"`, ISO timestamps) whenever `NODE_ENV=production` or `LOG_FORMAT=json`
  (render.yaml sets `LOG_FORMAT=json` on API and worker); short morgan lines in development. Level: `LOG_LEVEL` (default `info`).
- **Access log:** one line per request — `req.id`, method, URL **without query string**, bearer tokens in public receipt /
  order-tracking paths masked as `[token]`, status; level `warn` for 4xx, `error` for 5xx. `/health`, `/ready`, `/metrics` skipped.
- **Request ids:** `X-Request-Id` is accepted when well-formed (`[A-Za-z0-9._-]{8,64}`), otherwise a UUID is generated; it is
  echoed in the response header and in every access-log line. Support asks users / the web app for it when reporting errors.
- **Redaction** (censor `[redacted]`): authorization / cookie / API-key / CSRF headers, `set-cookie`, and any field named
  password, pin, otp, code, aadhaar(Number), access/refresh token, token, secret(s), key/webhook secrets, phone,
  customerPhone, mfaToken, recoveryCode, apiKey, … (full list: `REDACT` in `apps/api/src/lib/observability.ts`; unit test
  `observability.test.ts`).
- **Crashes:** `unhandledRejection` is reported; `uncaughtException` is reported and the process exits (the platform restarts it).

## Retention (recommendation — set in the log sink, the app keeps no log files)
| Data | Hot (searchable) | Archive | Why |
|---|---|---|---|
| Application / access logs | 30 days | 90 days (cold storage) then delete | Incident analysis; logs contain IPs (personal data under DPDP — keep short) |
| Error-tracker events | 30–90 days (vendor default) | — | |
| Business audit log (`AuditLog` table) | 13 months in DB | ≥ 8 years archived | GST record-keeping horizon — see [AUDIT_LOG_RETENTION.md](AUDIT_LOG_RETENTION.md) |
| pg-boss job history | 2 days (dead-letter queue 14 days) | — | set in `apps/api/src/jobs.ts` |

Render keeps only a short live log window: add a log stream (Render → Log Streams → Better Stack / Datadog / Grafana Loki)
before go-live and set the retention there.

## Error tracking (Sentry-ready, no dependency)
`reportError()` logs the error, increments `canavo_errors_total{kind}` and calls an optional reporter registered with
`setErrorReporter(fn)`. No Sentry package is installed, so nothing is sent until someone wires it. To enable:

1. `npm i @sentry/node -w @canavo/api` (a deliberate dependency decision).
2. At the top of `src/index.ts` and `src/worker.ts`, gated on an env var:
   ```ts
   if (process.env.SENTRY_DSN) {
     const Sentry = await import("@sentry/node");
     Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, sendDefaultPii: false });
     setErrorReporter((e, ctx) => Sentry.captureException(e, { extra: ctx }));
   }
   ```
3. Keep `sendDefaultPii: false`; the context passed is already free of request bodies.
