import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "../env";

/**
 * Off-site copies of platform backups (Phase 1.7). Backups are first written to the
 * API's disk; a copy then goes to an off-site store so losing the server doesn't lose
 * the backups. Adapters:
 *  - S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO) — set
 *    BACKUP_S3_BUCKET (+ region / endpoint / keys);
 *  - a directory (a mounted network volume; also the test double) — BACKUP_OFFSITE_DIR.
 * The platform admin still can't download backups through the app; off-site copies are
 * reached only with the storage provider's own credentials.
 */
export interface OffsiteObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface OffsiteStore {
  /** e.g. "s3://bucket/prefix" or "dir:/mnt/backups" */
  readonly location: string;
  put(key: string, filePath: string): Promise<void>;
  list(): Promise<OffsiteObject[]>;
  get(key: string, destPath: string): Promise<void>;
}

export class DirectoryStore implements OffsiteStore {
  constructor(private readonly dir: string) {}
  get location() {
    return `dir:${this.dir.endsWith(path.sep) ? this.dir : this.dir + path.sep}`;
  }
  async put(key: string, filePath: string) {
    await mkdir(this.dir, { recursive: true });
    await copyFile(filePath, path.join(this.dir, path.basename(key)));
  }
  async list() {
    await mkdir(this.dir, { recursive: true });
    const names = await readdir(this.dir);
    return Promise.all(
      names.map(async (key) => {
        const s = await stat(path.join(this.dir, key));
        return { key, size: s.size, lastModified: s.mtime };
      }),
    );
  }
  async get(key: string, destPath: string) {
    await copyFile(path.join(this.dir, path.basename(key)), destPath);
  }
}

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3Store implements OffsiteStore {
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;
  constructor(private readonly cfg: S3Config) {
    this.clientPromise = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          region: cfg.region,
          // Plain PUTs (no aws-chunked checksum trailers): compatible with R2 / B2 / MinIO.
          requestChecksumCalculation: "WHEN_REQUIRED",
          responseChecksumValidation: "WHEN_REQUIRED",
          ...(cfg.endpoint && { endpoint: cfg.endpoint, forcePathStyle: true }),
          ...(cfg.accessKeyId && cfg.secretAccessKey && { credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } }),
        }),
    );
  }
  get location() {
    return `s3://${this.cfg.bucket}/${this.cfg.prefix}`;
  }
  private k = (key: string) => `${this.cfg.prefix}${path.basename(key)}`;
  async put(key: string, filePath: string) {
    const [{ PutObjectCommand }, client, s] = await Promise.all([import("@aws-sdk/client-s3"), this.clientPromise, stat(filePath)]);
    await client.send(
      new PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key), Body: createReadStream(filePath), ContentLength: s.size, ContentType: "application/gzip" }),
    );
  }
  async list() {
    const [{ ListObjectsV2Command }, client] = await Promise.all([import("@aws-sdk/client-s3"), this.clientPromise]);
    const out: OffsiteObject[] = [];
    let token: string | undefined;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.cfg.prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push({ key: (o.Key ?? "").slice(this.cfg.prefix.length), size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async get(key: string, destPath: string) {
    const [{ GetObjectCommand }, client] = await Promise.all([import("@aws-sdk/client-s3"), this.clientPromise]);
    const r = await client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.k(key) }));
    await pipeline(r.Body as Readable, createWriteStream(destPath));
  }
}

/** The configured off-site store, or null (backups stay on the API disk only — logged as a warning in production). */
export function offsiteStore(): OffsiteStore | null {
  if (env.BACKUP_S3_BUCKET) {
    return new S3Store({
      bucket: env.BACKUP_S3_BUCKET,
      region: env.BACKUP_S3_REGION,
      prefix: env.BACKUP_S3_PREFIX,
      endpoint: env.BACKUP_S3_ENDPOINT,
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    });
  }
  if (env.BACKUP_OFFSITE_DIR) return new DirectoryStore(env.BACKUP_OFFSITE_DIR);
  return null;
}
