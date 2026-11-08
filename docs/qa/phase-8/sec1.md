# QA Phase 8: security (sec1)

Branch `agent/sec1`. Tests: `apps/api/test/api/security.test.ts` (runs with `npm run test:api`),
`src/lib/safe-url.test.ts`, `src/lib/observability.test.ts` and `src/lib/prod-mode.test.ts` (run with `npm test`).
This page doesn't repeat the Phase 6 checks (auth sweep, IDOR, CORS, headers, uploads, SSRF, webhooks, rate limits).

## Checks

| Area | Check | Result |
|---|---|---|
| XSS (web) | Searched for `dangerouslySetInnerHTML`, `innerHTML` and `document.write` | Only the two static theme scripts in `layout.tsx`. Print uses `textContent`. |
| XSS (web) | `href` / `window.open` built from data | Links stored by staff reached `<a href>` unchecked. React 18 doesn't block `javascript:` links: **sec1-1, sec1-2** |
| XSS (text) | `<script>`, `<img onerror>` and `<svg onload>` saved in names | Stored as typed and returned as JSON with `nosniff`. React escapes them on screen. |
| XSS (email) | Mailer HTML (notify, password links, report schedules) | Everything people type goes through `escapeHtml`. Report titles are fixed text. |
| XSS (receipts/PDF) | `/public/receipts` and bill PDFs | Built with pdfkit as plain text, so there is no HTML sink. The mobile `expo-print` HTML is escaped. |
| Exports | CSV/XLSX formula injection | The report exports and inventory were already safe. The attendance export was not: **sec1-3** |
| Printers | ESC/POS control bytes in names or guest notes | Mobile Bluetooth printing sent them to the printer as-is: **sec1-9** |
| Sessions | Cookie mode | The refresh cookie is httpOnly, `Secure` in production and SameSite=Lax. Refresh and logout through the cookie need the double-submit CSRF header. Every other request needs the bearer token, so no CSRF is possible. |
| Sessions | Fixation, rotation, reuse, logout | New random tokens at sign-in. Reusing an old refresh token revokes its whole family. Logout and revoking one device end that session's access token at once (`sid` check). |
| Sessions | Password change / reset | Self-change ends the other sessions and reset uses `forceLogout`. A password set by a manager did not end any session, and a stolen token could change its own password with no current password: **sec1-5** |
| 2FA | Bypass paths | Password and OTP sign-in both go through `completeFirstStep`. Reset and invite links don't sign anyone in. Support views need 2FA. The 2FA ticket and the access token use different keys and can't stand in for each other (test). |
| OTP | Lockout parity | Five failures lock both password and OTP sign-in, and the 2FA step counts towards the same lock. |
| Privilege | Custom roles, manager vs owner, support grants | `canWith` takes the intersection of role and custom role, and `assertSubset` blocks extra permissions. A manager can't edit the owner or grant support access (test). |
| Privilege | Platform support / super admin vs hotel data | `/integrations`, `/theatre`, `/channels`, `/storefront`, `/canteen` and `/support-access` all answer 401/403 (test). |
| IP whitelist | Scope | It covered `/admin` only. `/platform/*` and support views ignored it: **sec1-4** |
| Production | Dev-only endpoints | `dev-simulate` isn't registered (test). `devCode` / `devLink` only appear when `!isProd`. The demo seed and demo logins are refused in production. |
| Production | Error bodies | A 500 returns only `{error, requestId}` (test). |
| Production | Log redaction | Phones, CSRF token, 2FA ticket, recovery codes and password-change fields were not redacted. Receipt and order tokens appeared in access-log URLs: **sec1-7** |
| Production | TRUST_PROXY | `true` / `*` was accepted in production, which lets anyone fake X-Forwarded-For: **sec1-8** |
| SSRF | Channel hub DNS rebinding (BUG-048 residual) | The hub name was resolved again at connect time: **sec1-6** |
| Mobile | Token storage, logs, deep links | Tokens are in SecureStore (no AsyncStorage). The push log only runs under `__DEV__`. The `canavo://` routes still need a session. |

## Defects (all fixed, with tests)

| ID | Sev | Defect | Fix |
|---|---|---|---|
| sec1-1 | P1 | A cashier's clock-in `selfieUrl` such as `javascript://res.cloudinary.com/%0aalert(1)` passed `isOwnUpload` because its host is Cloudinary. It became a clickable link in the manager's daily register, so the script ran in the manager's session. | `isOwnUpload` accepts http(s) only. Web `mediaUrl()` returns "" for any scheme other than http(s), relative, `data:image/` or `blob:`. |
| sec1-2 | P1 | Purchase `invoiceImageUrl` accepted any string (`javascript:`, `data:text/html`). It was shown as a link in the purchase sheet. | New `httpLinkError()` check on purchase create and edit, plus the same `mediaUrl()` guard. |
| sec1-3 | P2 | Attendance CSV/XLSX wrote staff names, "marked by" and notes raw, so `=HYPERLINK(…)` / `+cmd` ran as formulas. | `safeCellText()` like the other exports. |
| sec1-4 | P1 | The super admin IP whitelist was enforced on `/admin` only. `/platform/*` and support views (`X-Support-Business`) worked from any IP. | `superAdminIpWhitelist` on `platformRouter`. `assertPlatformIpAllowed` in `enterSupport`. |
| sec1-5 | P2 | 1) A manager setting a staff member's new password left that person's existing sessions alive. 2) `PATCH /staff/<own id>` with a `password` changed your own password without the current one, so a stolen token could take over the account. | A password set by someone else calls `forceLogout`. Your own password through `/staff` gets a 400 pointing to Account → Security. |
| sec1-6 | P2 | DNS-rebinding window in `hubFetch` (resolve, check, then `fetch` resolved the name again). | The request goes through `node:http(s)` with a pinned `lookup` to the checked address. Host and SNI stay the hub's name. Redirects are still refused. The reply is capped at 5 MB. |
| sec1-7 | P3 | Logs: `*.phone`, `x-csrf-token`, `mfaToken`, `recoveryCode`, `current/newPassword`, `apiKey` and `aadhaarNumber` were not redacted. Access-log URLs held receipt and online-order tokens. | Added to the pino `REDACT` list. New `logUrl()` masks the tokens and drops query strings. |
| sec1-8 | P2 | `TRUST_PROXY=true` (or `*` or `0.0.0.0/0`) was allowed in production. Any client could then forge X-Forwarded-For, bypassing per-IP limits and the IP whitelist and faking audit IPs. | `productionConfigProblems` refuses it. |
| sec1-9 | P3 | Mobile Bluetooth ESC/POS sent control bytes from item names and guest QR notes. ESC p opens the cash drawer. | C0/C1 control characters are removed before `printText`. |

## Safe configuration and escape hatches

- **TRUST_PROXY**: use `loopback, linklocal, uniquelocal`, which is the default and what render.yaml sets, or the exact hop count. Express takes the right-most untrusted X-Forwarded-For entry. A client-supplied left part is ignored as long as only your own proxies are trusted. If the setting is wrong (`true`), every per-IP limit and the whitelist can be bypassed. Production now refuses to start with it.
- **IP whitelist lock-out**: saving a list that doesn't include your current IP is refused. Signing in is never blocked. If the office IP changes, run `DELETE FROM "Setting" WHERE scope='GLOBAL' AND key='security.ipWhitelist';` as the DB owner. This needs database access, so a remote attacker can't use it.

## Recommendations (no failing behaviour)

- Shared zod `z.string().url()` (menu `imageUrl`, `logoUrl`) accepts `javascript:`. These values are only used in `<img src>` today, which can't run script. Add a scheme refine in `packages/shared` (out of scope for this agent).
- `services/backup.ts` `csvCell` doesn't apply the formula prefix. This is deliberate: backups must round-trip exactly. Warn in the UI that the export is not meant to be opened in Excel.
- Lockout leaks whether an account exists: after five failures a registered account answers 423, an unknown one 401. This is the usual trade-off. A generic 401 while locked would close it.
- With `AUTH_COOKIE_DOMAIN` set, a hostile sibling subdomain could plant both cookies (cookie tossing). Keep every host under that domain trusted.
- Moving web to React 19 would block `javascript:` hrefs by default.

## Not verified

- Live SMTP or SMS rendering (only the code was reviewed).
- Physical printer behaviour.
- iOS/Android deep-link association files: no universal links are configured.
