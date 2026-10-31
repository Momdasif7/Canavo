import { apiBase } from "./api";

const LOCAL_UPLOAD = /\/uploads\/files\/([^/?#]+)(?:[?#].*)?$/;

/**
 * Display URL for an uploaded image. Local uploads are stored as absolute URLs
 * containing whatever host the uploader used (localhost, a LAN IP, an ngrok
 * domain…), which breaks on other devices. Any URL whose path ends in
 * `/uploads/files/<name>` is rewritten to this app's current API base; other
 * URLs (Cloudinary, CDNs, data: URIs) are returned unchanged.
 */
export function mediaUrl(url: string | null | undefined): string {
  const raw = url?.trim() ?? "";
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return raw;
  const m = LOCAL_UPLOAD.exec(raw);
  if (!m) return raw;
  return `${apiBase()}/uploads/files/${m[1]}`;
}
