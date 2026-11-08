import { apiBase } from "./api";

const LOCAL_UPLOAD = /\/uploads\/files\/([^/?#]+)(?:[?#].*)?$/;

/**
 * Display URL for an uploaded image. Local uploads are stored as absolute URLs
 * containing whatever host the uploader used (localhost, a LAN IP, an ngrok
 * domain…), which breaks on other devices. Any URL whose path ends in
 * `/uploads/files/<name>` is rewritten to this app's current API base; other
 * http(s) URLs (Cloudinary, CDNs) and data:image / blob: previews are returned unchanged; other
 * schemes become "".
 */
export function mediaUrl(url: string | null | undefined): string {
  const raw = url?.trim() ?? "";
  if (!raw || raw.startsWith("data:image/") || raw.startsWith("blob:")) return raw;
  // Shown in <a href> and <img src>: anything but http(s) or a relative path (javascript:, data:text/html…)
  // would run script when clicked — React 18 doesn't block it (QA Phase 8, sec1-1/2).
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) return "";
  const m = LOCAL_UPLOAD.exec(raw);
  if (!m) return raw;
  return `${apiBase()}/uploads/files/${m[1]}`;
}
