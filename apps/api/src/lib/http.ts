import { reportError } from "./observability";
import type { NextFunction, Request, Response } from "express";
import { z, ZodError, ZodType } from "zod";
import { Prisma } from "@prisma/client";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, msg);

export function parse<S extends ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw badRequest("Validation failed", result.error.flatten());
  return result.data;
}

/** PostgreSQL deadlock (40P01) / serialization failure (40001), however Prisma wrapped it. */
export function isTransactionConflict(err: unknown) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") return true;
  return (err instanceof Prisma.PrismaClientUnknownRequestError || err instanceof Prisma.PrismaClientKnownRequestError) && /\b40P01\b|\b40001\b|deadlock detected/.test(err.message);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: err.flatten() });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return res.status(409).json({ error: "Already exists", details: err.meta });
    if (err.code === "P2025") return res.status(404).json({ error: "Not found" });
    // A referenced id that doesn't exist (or isn't visible): the client's mistake, not ours
    if (err.code === "P2003") return res.status(400).json({ error: "A referenced record was not found" });
    if (err.code === "P2020" || err.code === "P2033") return res.status(400).json({ error: "A number is too large" });
  }
  // Two transactions that locked the same rows in opposite order (or a serialization conflict):
  // PostgreSQL rolled one back. Nothing was saved, so the client can safely send it again (QA Phase 7).
  if (isTransactionConflict(err)) {
    return res.status(409).json({ error: "Someone else changed the same records at the same moment. Nothing was saved — please try again.", details: { code: "TRY_AGAIN" } });
  }
  // A number too large for its 32-bit column (paise, points, quantities sent by the client)
  if (err instanceof Prisma.PrismaClientUnknownRequestError && /Unable to fit integer value|out of range for type integer/.test(err.message)) {
    return res.status(400).json({ error: "A number is too large" });
  }
  // PostgreSQL text can't hold U+0000 (22021) — bad input that slipped past rejectNulBytes, not a server fault.
  if (err instanceof Error && /\b22021\b|invalid byte sequence for encoding/.test(err.message)) {
    return res.status(400).json({ error: "Text contains an invalid character" });
  }
  // body-parser / http-errors (malformed JSON, payload too large, ...)
  const status = (err as { status?: number; expose?: boolean }).status;
  if ((err as { expose?: boolean }).expose && status && status < 500) {
    return res.status(status).json({ error: (err as Error).message });
  }
  // Unexpected: report with the request id; the client gets the id (to quote to support), never a stack trace.
  reportError(err, { kind: "request", requestId: req.id, method: req.method, route: req.originalUrl.split("?")[0] });
  res.status(500).json({ error: "Internal server error", requestId: req.id });
}

const hasNul = (v: unknown, depth = 0): boolean => {
  if (typeof v === "string") return v.includes("\u0000");
  if (depth > 64 || v === null || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => k.includes("\u0000") || hasNul(x, depth + 1));
};

/**
 * Refuse U+0000 anywhere in the URL (path, ids, query) or a parsed JSON body with a 400:
 * PostgreSQL text can't store it, so it would otherwise surface as a database error (QA BUG-006).
 */
export function rejectNulBytes(req: Request, _res: Response, next: NextFunction) {
  let url = req.originalUrl;
  try {
    url = decodeURIComponent(url.replace(/\+/g, " "));
  } catch {
    /* malformed %-escapes: Express answers those itself */
  }
  if (url.includes("\u0000") || hasNul(req.body)) return next(badRequest("Text contains an invalid character"));
  next();
}

/** Read a route param as a string (Express 5 types allow string | string[]). */
export const param = (req: Request, name: string): string => String(req.params[name]);

/**
 * Public base URL of the API for links shown to customers (receipts, images).
 * Behind the gateway / ngrok it follows the address the request came in on
 * (X-Forwarded-Host → https://abc.ngrok-free.app/api); otherwise PUBLIC_API_URL.
 */
export function publicApiUrl(req: Request, fallback: string): string {
  const fwdHost = req.header("x-forwarded-host");
  if (fwdHost) {
    const proto = (req.header("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
    // The gateway serves the API under /api
    return `${proto}://${fwdHost.split(",")[0].trim()}/api`;
  }
  return fallback.replace(/\/$/, "");
}
