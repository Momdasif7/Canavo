# ADR 0006: Web sessions in httpOnly cookies, with a storage fallback

| | |
|---|---|
| Status | Accepted (Phase 2.7, 2026-11-01) |
| Decision refs | D16 |

## Context

The web app kept the access token and the 7-day refresh token in `localStorage`. Any script injected into the page (XSS) could read them and use the account from anywhere. httpOnly cookies can't be read by scripts. However, browsers send cookies to the API only when the web app and the API are on the **same site** (for example `app.example.in` and `api.example.in`). They're not shared between `*.vercel.app` and `*.onrender.com`.

## Decision

- **Opt-in per request.** The web app sends `X-Session-Mode: cookie` on login and 2FA verify, and refresh then works through the cookie. The API then:
  - puts the refresh token in an httpOnly, `SameSite=Lax` cookie (Secure in production), on `AUTH_COOKIE_DOMAIN` when that is set;
  - leaves the refresh token out of the JSON body;
  - sets a readable `canavo_csrf` cookie.
- **CSRF.** Refresh and logout through the cookie need `X-CSRF-Token` to equal `canavo_csrf` (double-submit). Every other API call is authorised by the bearer access token, which a cross-site page can't attach, so those calls need no CSRF token.
- **Access token.** In cookie mode it is kept **in memory only**. After a reload the app gets a new one from the cookie. `localStorage` holds only a marker that says "cookie session".
- **Choosing the mode.** `NEXT_PUBLIC_SESSION_MODE=auto` is the default. The login page calls `POST /auth/cookie-probe`, which sets a readable test cookie, and uses cookie mode only if the page can read it back:
  - **cookie mode** on same-site domains, or on one origin through the gateway;
  - **storage mode** on `*.vercel.app` + `*.onrender.com`, exactly as before.

  `storage` and `cookie` force one or the other.
- **CORS.** `credentials: true`, only for origins listed in `CORS_ORIGINS`. A wildcard `*` is refused in production.
- **Unchanged.** The mobile app (SecureStore) and existing storage-mode sessions.

## Consequences

- With custom domains (`app.` + `api.` of your domain, set out in DEPLOYMENT.md), an XSS bug can no longer steal a lasting session. At most it can act while the page is open.
- Several tabs share one cookie. Refreshes are already serialised across tabs (a Web Lock), so a rotated token is never reused.
- **Rollback:** set `NEXT_PUBLIC_SESSION_MODE=storage` and redeploy the web app. The API keeps accepting body refresh tokens.
