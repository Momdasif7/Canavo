import crypto from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { env, isProd } from "../env";
import { forbidden } from "./http";

/**
 * Web sessions in httpOnly cookies (Phase 2.7, D16). The web app opts in per request with
 * `X-Session-Mode: cookie` (only after a probe showed the browser keeps and shares our
 * cookies, i.e. app.example.in + api.example.in, or one origin through a gateway):
 *  - the refresh token goes into an httpOnly cookie (scripts — and XSS — can't read it) and
 *    is left out of the JSON body; the short-lived access token stays in memory only;
 *  - refresh and logout through the cookie need the double-submit CSRF header
 *    (X-CSRF-Token = the readable canavo_csrf cookie). Everything else uses the bearer
 *    access token, which a cross-site page can't attach, so it needs no CSRF token.
 * Without the header (mobile app, *.vercel.app + *.onrender.com) nothing changes.
 */
export const REFRESH_COOKIE = "canavo_rt";
export const CSRF_COOKIE = "canavo_csrf";
export const PROBE_COOKIE = "canavo_probe";
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const wantsCookieSession = (req: Request) => req.header("x-session-mode") === "cookie";

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function baseOptions(req: Request): CookieOptions {
  return {
    secure: isProd || req.secure,
    sameSite: "lax",
    path: "/",
    ...(env.AUTH_COOKIE_DOMAIN && { domain: env.AUTH_COOKIE_DOMAIN }),
  };
}

export function setSessionCookies(req: Request, res: Response, refreshToken: string) {
  const base = baseOptions(req);
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true, maxAge: REFRESH_MAX_AGE_MS });
  res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString("base64url"), { ...base, httpOnly: false, maxAge: REFRESH_MAX_AGE_MS });
}

export function clearSessionCookies(req: Request, res: Response) {
  const base = baseOptions(req);
  res.clearCookie(REFRESH_COOKIE, { ...base, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}

/** A readable test cookie with the same attributes: the web app checks it can see it before using cookie mode. */
export function setProbeCookie(req: Request, res: Response) {
  res.cookie(PROBE_COOKIE, "1", { ...baseOptions(req), httpOnly: false, maxAge: 60_000 });
}

/** Refresh token from the cookie, after the double-submit CSRF check. */
export function cookieRefreshToken(req: Request): string | undefined {
  const token = readCookie(req, REFRESH_COOKIE);
  if (!token) return undefined;
  const csrf = readCookie(req, CSRF_COOKIE);
  const header = req.header("x-csrf-token");
  if (!csrf || !header || csrf.length !== header.length || !crypto.timingSafeEqual(Buffer.from(csrf), Buffer.from(header))) {
    throw forbidden("Missing or wrong CSRF token");
  }
  return token;
}

/** Send a new session: in cookie mode the refresh token goes into the cookie, not the body. */
export function sendSession(req: Request, res: Response, session: { accessToken: string; refreshToken: string; expiresIn: number }) {
  if (!wantsCookieSession(req)) return res.json(session);
  setSessionCookies(req, res, session.refreshToken);
  return res.json({ accessToken: session.accessToken, expiresIn: session.expiresIn, sessionMode: "cookie" });
}
