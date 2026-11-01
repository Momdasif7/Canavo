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
