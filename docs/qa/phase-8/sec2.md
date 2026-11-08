# QA Phase 8 — sec2: dependency, secret, SAST, DAST and container scanning

Branch `agent/sec2`, 2026-11-08. App-logic security (XSS, sessions, escalation) is sec1's section.
Repeatable: `npm run security:secrets` (gitleaks, Docker), `npm run security:sast` (semgrep, Docker).

## Scan results

| Scan | Tool | Before | After | Notes |
|---|---|---|---|---|
| npm audit (root workspaces) | npm 11 | 27 (3 crit, 11 high, 13 mod) | 20 (3 crit, 8 high, 9 mod) | production deps only: 8 (1 crit, 5 high, 2 mod); every one left needs a major bump (see accepted risks) |
| npm audit (apps/mobile) | npm 11 | 57 (1 crit, 24 high) | unchanged | `audit fix` broke the Metro bundle (it nested a second react-native), so it was reverted; the rest need Expo SDK 51 → 58 |
| Licences (production deps) | lockfile scan | — | no GPL/AGPL-only | dual-licensed `jszip` (MIT or GPL-3), `node-forge` (BSD or GPL-2): we use them under MIT/BSD. `react-leaflet` + `@react-leaflet/core` are **Hippocratic-2.1** (ethical-use licence, not OSI): legal should review. UNKNOWN entries `buffers`, `png-js` (exceljs/pdfkit deps) are MIT per their READMEs |
| Secrets, working tree | gitleaks 8.30.1 | 15 | 0 | all test/CI fixtures, now allowlisted in `.gitleaks.toml` |
| Secrets, git history (all refs, 114 commits) | gitleaks 8.30.1 | 17 | 0 | same fixtures. **No real secret found, nothing to rotate** |
| SAST apps/ + packages/ | semgrep (p/javascript, typescript, nodejs, react, secrets, owasp-top-ten; 122 rules, 671 files) | 10 | 0 | 1 true positive fixed (sec2-3); 2 Dockerfile findings fixed then marked `nosemgrep`; 7 in test fixtures = false positives |
| DAST web, passive baseline (user's app :8080) | ZAP baseline | 7 WARN, 0 FAIL | 4 WARN, 0 FAIL (checked on a scratch build of this branch) | fixed: CSP, X-Frame-Options, nosniff, Permissions-Policy, COOP. Left: CSP wildcard (`img-src https:`), COEP, cache info |
| DAST API, passive baseline (user's app :8080/api) | ZAP baseline | 0 issues on API URLs | — | helmet headers, `no-store`, CORS are correct |
| DAST API, active (scratch API :4170, OpenAPI 394 URLs, owner token) | ZAP api-scan | 1 WARN, 0 FAIL, 119 PASS | — | "Cookie No HttpOnly" on `/auth/cookie-probe` is a false positive: the probe cookie has to be readable by scripts and holds only `1`. Session cookies are httpOnly, SameSite=Lax, Secure in production |
| Container | manual + build + run | runs as root, no healthcheck, no .dockerignore | non-root, healthcheck, .dockerignore | image built and run against a scratch DB: migrations ran, API answered as uid 1000, health = healthy |

Gates after the changes: `tsc` api + web clean, lint clean (1 old warning), unit 161/161, integration 207/207,
`test:api` 782/782, `test:db` 10/10 files on `canavo_it_sec2`; `next build` passes (separate distDir).

## Defects

| ID | Sev | Area | Defect | Fix |
|---|---|---|---|---|
| sec2-1 | P1 security | deps | Production deps with fixes available inside their semver range: multer 2.4.0 (DoS, GHSA-q7qp-rjg7-q26m), body-parser 2.3.0 (DoS, GHSA-27r3-jxmh-p828), nodemailer < 10.1.4 (addressparser recipient injection), qs, ip-address; dev: vite 7.3.6, typescript-eslint | lockfile only: multer 2.5.0, body-parser 2.4.0, nodemailer 10.4.0, qs 6.17.1, vite 7.3.7. **Run `npm install` in the main checkout to pick these up** |
| sec2-2 | P1 security | web / deps | Next 14.2.35 is affected by critical unauthenticated RCE in the Image Optimization API (GHSA-2464-fhr4-w9xw SVG, GHSA-2xp9-vwfh-vxw4 AVIF) and its DoS advisories. `/_next/image` is on by default even though the app never uses `next/image` | `images.unoptimized: true`: `/_next/image` now returns 404 (checked). Next 15/16 upgrade still recommended (see risks) |
| sec2-3 | P2 security | api crypto | AES-256-GCM field encryption (Aadhaar, WhatsApp/Razorpay tokens) did not fix the auth-tag length. On Node 22, the production image's runtime, `decipher` **accepted a 4-byte tag** (checked), so anyone who can write to the DB could forge ciphertexts much more easily. Node 26 locally already rejects short tags | `authTagLength: 16` on cipher and decipher, plus an explicit length check; test `rejects a truncated auth tag` |
| sec2-4 | P2 security | web headers | Web app sent no CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP or HSTS (ZAP 10020/10021/10038/10063) | `next.config.mjs` `headers()`: CSP (default-src 'self', API origin + ws from `NEXT_PUBLIC_API_URL`, Nominatim, frame-ancestors 'self', object-src 'none', base-uri/form-action 'self'), XFO SAMEORIGIN, nosniff, strict-origin-when-cross-origin, Permissions-Policy (camera/geolocation self only), COOP same-origin-allow-popups, HSTS 1y (production) |
| sec2-5 | P2 security | container | No `.dockerignore`: `COPY apps/api` copied a local `apps/api/.env` (it exists in the main checkout) and `storage/` (uploads, backups) into any image built locally. Render builds from git, so its images were not affected | `.dockerignore` excludes `**/.env*`, storage, node_modules, build output, .git, docs, mobile, web |
| sec2-6 | P3 security | container | API container ran as root, with no HEALTHCHECK | entrypoint makes the storage disk writable, then `setpriv` drops to `node` (uid 1000) for the API, worker and migrations; `COPY --chown`; HEALTHCHECK on `/health`; `--no-install-recommends` |

Also added: `.gitleaks.toml`, `.semgrepignore`, `scripts/security/{secrets,sast}.sh`, and npm scripts `security:secrets` / `security:sast`.

## SAST false positives (triaged)
- `hardcoded-jwt-secret` ×6 in `apps/api/test/api/storefront.test.ts` and a `detected-bcrypt-hash` in `test/db/perf-seed.sql`:
  these are test fixtures, so test code is excluded in `.semgrepignore`.
- `dockerfile missing-user(-entrypoint)`: the entrypoint drops privileges itself (`nosemgrep` with the reason).
- 6 JSX files only partly parsed (text like `Save & send` trips semgrep's parser). That is a tool limit; the rest of each file was scanned.

## Accepted risks / follow-ups
- **next 14.2.35** (1 critical, plus high RSC/Server-Action DoS and SSRF advisories, fixed only in ≥ 15.5.28): the app has no
  middleware, rewrites, i18n, Server Actions or custom server, and the image optimizer is now off. The left-over RSC DoS
  is the real exposure. On Vercel the platform takes on part of it. **Recommendation: upgrade to Next 15.5.x + React 19 as its own task.**
- **zod 3.25.76** (GHSA-mrhx-c7xc-m3w5, memory use on oversized constrained collections; fix only in zod 4): request bodies are capped by
  `express.json({ limit: "1mb" })`, which bounds the input. Zod 4 migration is a later task.
- **prisma 6.19.3 → @prisma/config → deepmerge-ts** (stack exhaustion when merging recursive objects): it only merges the
  local Prisma config, never attacker input. The fix is Prisma 7 (major).
- **exceljs → uuid < 11.1.1**: only affects v3/v5/v6 with a caller-supplied buffer; exceljs uses v4. Not exploitable.
- **Dev-only**: vitest 3 / tinypool (critical prototype-pollution gadgets, fixed in vitest 5), eslint-config-next 14 → glob/minimatch.
  None of these ship to production.
- **Mobile** (Expo SDK 51): almost all are build tooling (`@expo/cli`, tar, cacache, xmldom/plist, metro postcss). Runtime ones
  (`decode-uri-component` and `query-string` via react-navigation) are client-side DoS at most. Upgrade the Expo SDK as its own task.
- CSP keeps `'unsafe-inline'` for scripts (App Router inline hydration; a nonce needs middleware and dynamic rendering) and
  `img-src https:` (Cloudinary, map tiles, image URLs merchants enter). No COEP: it would block cross-origin images.
- The image ships dev deps: the Prisma CLI, a devDependency, is needed for `migrate deploy` at start.
- The Render disk ownership fix runs as root at start (chown of `storage/` only), then drops privileges.
