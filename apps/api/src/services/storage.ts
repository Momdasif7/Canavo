import path from "node:path";
import { mkdirSync } from "node:fs";
import { env } from "../env";

/** Local storage root (uploads, backups, outbox). Defaults to apps/api/storage. */
export const STORAGE_ROOT = path.resolve(env.STORAGE_DIR ?? path.join(__dirname, "..", "..", "storage"));

export function storageDir(...parts: string[]): string {
  const dir = path.join(STORAGE_ROOT, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
