# Phase 8: Security testing

Two streams ran in parallel; full detail is in [phase-8/sec1.md](phase-8/sec1.md) (application security) and [phase-8/sec2.md](phase-8/sec2.md) (scanning). Phase 6 had already covered the authentication sweep, IDOR/role matrices, CORS, uploads, SSRF, webhooks and rate limits, so they were not repeated.

## Result

| Suite | Result |
|---|---|
| Unit | shared 56, api 169 |
| Integration | 207 / 207 |
| API (incl. new `security.test.ts`) | 792 / 792 |
| Database | 10 / 10 files |
| Typecheck and lint | clean |

**15 defects found (BUG-085 to BUG-099), all fixed.** By severity: P1 6, P2 7, P3 2.

There were **no real secrets** in the code or in the git history (gitleaks).

## Checks

| Area | Outcome |
|---|---|
| Stored XSS: pages, receipts, PDFs, emails, printed tickets | React escaping, emails and PDFs were sound. Fixed: selfie and invoice links, plus the shared URL fields, now accept http(s) only. |
| Sessions and authentication | Cookie sessions with CSRF, refresh rotation, 2FA, lockout and custom roles were sound. Fixed: a password set by a manager now signs the person out. |
| Platform privilege | The IP whitelist now covers `/platform` and support views. Platform users can't reach hotel data through any route. |
| Production hardening | Dev endpoints and the demo seed are off in production, and errors carry no stack traces. `TRUST_PROXY=true` is refused. Logs now hide phones, tokens and password fields. |
| SSRF residual | Hub calls connect to the checked IP while still verifying the certificate, with a 5 MB reply cap. |
| Dependencies | 27 → 20 findings. Fixed in-range upgrades and turned off the vulnerable Next image endpoint. The rest need major upgrades and are accepted risks (below). |
| SAST (semgrep), secrets (gitleaks) | 0 left. New `npm run security:sast` and `npm run security:secrets`. |
| DAST (ZAP) | Passive scan of the running app: only missing web headers, now added. Active scan of a scratch API: 119 checks pass. |
| Crypto and containers | AES-GCM tag pinned to 16 bytes. Added `.dockerignore`; the container runs as non-root with a healthcheck. |
| Mobile | Tokens are in SecureStore. Printer control characters are now stripped. |

## Accepted risks and recommendations

- **Next 15 + React 19:** upgrade as a separate task. It removes the remaining Server Components DoS advisories and blocks `javascript:` links by default.
- **Expo 51 → 58:** most of the mobile audit findings are build tools that need this upgrade.
- **zod 3, Prisma 6, exceljs' uuid:** remaining advisories need major bumps; requests are capped at 1 MB.
- **CSP:** still allows inline scripts (`'unsafe-inline'`); move to nonces with the Next upgrade.
- **Lockout enumeration:** after five failures, a real account answers 423 and an unknown one 401, which reveals which accounts exist. Align the answers.
- **`react-leaflet` licence:** Hippocratic-2.1 needs a legal review.
- **IP whitelist lockout escape hatch:** delete the `GLOBAL` / `security.ipWhitelist` setting row as the database owner.
