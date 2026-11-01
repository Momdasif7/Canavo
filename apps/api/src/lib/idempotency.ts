import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { platformPrisma as db } from "../db";
import { HttpError } from "./http";

/**
 * Idempotency-Key support for every authenticated mutation (POST/PUT/PATCH/DELETE).
 *
 * A client that may retry (flaky network, double tap, offline replay) sends a unique
 * `Idempotency-Key` per user action and reuses it on retries:
 *  - first request: runs normally; its status + JSON body are stored for 24 h;
 *  - same key + same request again: the stored response is replayed
 *    (`Idempotent-Replayed: true`), nothing runs twice;
 *  - same key + different method/path/body: 422;
 *  - same key while the first request is still running: 409 (retry shortly);
 *  - 5xx responses are not stored, so a retry after a server error runs again.
 * Keys are per user (a key can never replay another user's or hotel's response).
 */

const HEADER = "idempotency-key";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export const requestHash = (method: string, path: string, body: unknown) =>
  createHash("sha256").update(`${method}\n${path}\n${body === undefined ? "" : JSON.stringify(body)}`).digest("hex");

export async function withIdempotency(req: Request, res: Response, next: NextFunction, userId: string) {
  const key = req.header(HEADER);
  if (!key || !MUTATING.has(req.method)) return next();
  if (!KEY_RE.test(key)) return next(new HttpError(400, "Idempotency-Key must be 8–128 characters: letters, digits, - _ : ."));
  const path = req.originalUrl.split("?")[0]!;
  const hash = requestHash(req.method, req.originalUrl, req.is("application/json") ? req.body : { length: req.header("content-length") ?? "" });

  let row;
  try {
    row = await db.idempotencyKey.create({ data: { userId, key, requestHash: hash, method: req.method, path, expiresAt: new Date(Date.now() + TTL_MS) } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    const existing = await db.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
    if (!existing || existing.expiresAt < new Date()) {
      // Expired (or removed meanwhile): treat as new.
      await db.idempotencyKey.deleteMany({ where: { userId, key } });
      return withIdempotency(req, res, next, userId);
    }
    if (existing.requestHash !== hash) return next(new HttpError(422, "This Idempotency-Key was already used for a different request"));
    if (existing.responseStatus === null) return next(new HttpError(409, "A request with this Idempotency-Key is still being processed; retry shortly"));
    res.setHeader("Idempotent-Replayed", "true");
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  // Capture the JSON response to store it once the request has finished.
  let captured: unknown;
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    captured = body;
    return json(body);
  };
  res.on("finish", () => {
    const store = async () => {
      const size = captured === undefined ? 0 : Buffer.byteLength(JSON.stringify(captured));
      if (res.statusCode >= 500 || size > MAX_BODY_BYTES) {
        await db.idempotencyKey.delete({ where: { id: row.id } });
        return;
      }
      await db.idempotencyKey.update({
        where: { id: row.id },
        data: { responseStatus: res.statusCode, responseBody: captured === undefined ? Prisma.JsonNull : (captured as Prisma.InputJsonValue) },
      });
    };
    store().catch((e) => console.error("[idempotency] could not store response", e));
  });
  res.on("close", () => {
    // Client went away before a response: free the key so a retry can run.
    if (!res.writableFinished) void db.idempotencyKey.deleteMany({ where: { id: row.id, responseStatus: null } }).catch(() => undefined);
  });
  next();
}

/** Remove expired keys (scheduled job). */
export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const { count } = await db.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
