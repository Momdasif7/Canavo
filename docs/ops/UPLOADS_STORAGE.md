# Uploaded images: storage

## Today (`apps/api/src/routes/uploads.ts`)
- `POST /uploads/image` (authenticated): JPEG / PNG / WebP only (magic-byte sniffed), ≤ 5 MB.
- **Cloudinary configured** (`CLOUDINARY_CLOUD_NAME/_API_KEY/_API_SECRET`): uploaded there (folder `CLOUDINARY_FOLDER`);
  the app also signs direct browser → Cloudinary uploads (`GET /uploads/signature`). Durable, CDN-served.
- **Otherwise:** written to `STORAGE_DIR/uploads` (Render disk `canavo-storage`, 5 GB, mounted at `/repo/apps/api/storage`)
  and served by the API at `GET /uploads/files/:name` with `Cache-Control: public, max-age=31536000, immutable`.
  The same disk holds manual backups (`storage/backups`) and the email outbox (`storage/outbox`).

Problems with the local disk path: a Render disk pins the service to **one instance** (no horizontal scaling), is not in
the platform backup, survives only as long as the disk, and images are served through the API process.

## Plan
| Step | When | What |
|---|---|---|
| 1 | Before go-live | Set the Cloudinary variables in production (no code change). Local disk stays the dev fallback. |
| 2 | Before scaling to >1 API instance | Add an S3-compatible driver (`@aws-sdk/client-s3` is already a dependency for off-site backups): `UPLOADS_S3_BUCKET` (+ region / endpoint / keys), public-read bucket or CDN (Cloudflare R2 + custom domain), same object names. |
| 3 | Migration | One-off script: copy `storage/uploads/*` to the bucket; rewrite stored URLs `…/uploads/files/<name>` → CDN URL (menu item images, logos, appearance settings) in one transaction per business; keep `GET /uploads/files/:name` as a 301 redirect for old printed QR / cached links. |
| 4 | After | Remove the disk from canavo-api (backups already live off-site via the worker). |

Bucket policy: versioning on, lifecycle for incomplete multipart uploads, server-side encryption, keys scoped to the bucket.
Orphan cleanup (images no longer referenced) is a later, low-priority job.
