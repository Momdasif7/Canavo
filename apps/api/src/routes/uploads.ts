import express, { Router, type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import multer from "multer";
import { env } from "../env";
import { badRequest, HttpError, notFound, param, publicApiUrl } from "../lib/http";
import { authenticate } from "../middleware/auth";
import { storageDir } from "../services/storage";

export const uploadsRouter = Router();

const MAX_BYTES = 5 * 1024 * 1024;
const FILE_RE = /^[a-zA-Z0-9_-]{8,64}\.(jpg|png|webp)$/;
const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const uploadsDir = () => storageDir("uploads");

/** Detect jpeg/png/webp from magic bytes (the declared content type is not trusted). */
export function sniffImage(buf: Buffer): "jpg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

const cloudinaryConfigured = () => Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

/** Cloudinary signature: SHA-1 of the alphabetically sorted params joined as k=v&k=v, followed by the API secret. */
export function cloudinarySignature(params: Record<string, string | number>, secret: string): string {
  const str = Object.keys(params)
    .filter((k) => params[k] !== "" && params[k] !== undefined)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(str + secret).digest("hex");
}

function signedParams(folder: string) {
  const params = { folder, timestamp: Math.floor(Date.now() / 1000) };
  return { ...params, signature: cloudinarySignature(params, env.CLOUDINARY_API_SECRET!), api_key: env.CLOUDINARY_API_KEY! };
}

async function uploadToCloudinary(buf: Buffer, ext: string): Promise<string> {
  const p = signedParams(env.CLOUDINARY_FOLDER);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: CONTENT_TYPES[ext] }), `upload.${ext}`);
  for (const [k, v] of Object.entries(p)) form.append(k, String(v));
  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: form });
  const json = (await res.json()) as { secure_url?: string; error?: { message: string } };
  if (!res.ok || !json.secure_url) throw new HttpError(502, `Cloudinary upload failed: ${json.error?.message ?? res.status}`);
  return json.secure_url;
}

// ---------- Public: serve locally stored files (registered before authenticate) ----------

uploadsRouter.get("/files/:name", async (req, res) => {
  const name = param(req, "name");
  if (!FILE_RE.test(name)) throw notFound("File");
  const full = path.join(uploadsDir(), name);
  try {
    await stat(full);
  } catch {
    throw notFound("File");
  }
  res.setHeader("cache-control", "public, max-age=31536000, immutable");
  res.setHeader("x-content-type-options", "nosniff");
  res.type(CONTENT_TYPES[name.split(".").pop()!]).sendFile(full);
});

// ---------- Authenticated ----------

uploadsRouter.use(authenticate);

const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }).single("file");

/** Accept multipart/form-data (field "file") or a raw image/* body. */
function readImage(req: Request, res: Response, next: NextFunction) {
  if (req.is("multipart/form-data")) {
    multipart(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(err.code === "LIMIT_FILE_SIZE" ? new HttpError(413, "Image must be 5 MB or smaller") : badRequest(err.message));
      }
      // busboy parse errors ("Malformed part header", "Unexpected end of form"): the client's body, not a crash
      next(err ? badRequest("Malformed multipart upload") : undefined);
    });
    return;
  }
  express.raw({ type: "image/*", limit: MAX_BYTES })(req, res, (err?: unknown) => {
    if (err && (err as { type?: string }).type === "entity.too.large") return next(new HttpError(413, "Image must be 5 MB or smaller"));
    next(err);
  });
}

uploadsRouter.post("/image", readImage, async (req, res) => {
  const buf = req.file?.buffer ?? (Buffer.isBuffer(req.body) ? (req.body as Buffer) : undefined);
  if (!buf || buf.length === 0) throw badRequest('Send an image as multipart field "file" or as a raw image/jpeg|png|webp body');
  if (buf.length > MAX_BYTES) throw new HttpError(413, "Image must be 5 MB or smaller");
  const ext = sniffImage(buf);
  if (!ext) throw badRequest("Only JPEG, PNG or WebP images are allowed");

  if (cloudinaryConfigured()) {
    const url = await uploadToCloudinary(buf, ext);
    return res.status(201).json({ url, storage: "cloudinary", bytes: buf.length });
  }
  const name = `${Date.now().toString(36)}-${randomBytes(9).toString("base64url")}.${ext}`;
  await writeFile(path.join(uploadsDir(), name), buf);
  res.status(201).json({ url: `${publicApiUrl(req, env.PUBLIC_API_URL)}/uploads/files/${name}`, storage: "local", bytes: buf.length });
});

/** Signed parameters for direct browser/app → Cloudinary uploads. */
uploadsRouter.get("/signature", (_req, res) => {
  if (!cloudinaryConfigured()) {
    return res.status(404).json({ error: "Cloudinary is not configured; upload through POST /uploads/image", configured: false });
  }
  const p = signedParams(env.CLOUDINARY_FOLDER);
  res.json({
    configured: true,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: p.api_key,
    timestamp: p.timestamp,
    folder: p.folder,
    signature: p.signature,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  });
});
