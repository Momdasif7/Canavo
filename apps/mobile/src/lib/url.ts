/**
 * Pure URL helpers (no React Native imports, so node scripts can test them).
 *
 * The API may sit behind a single-port gateway / ngrok under a path prefix,
 * e.g. EXPO_PUBLIC_API_URL=https://abc.ngrok-free.app/api. REST calls simply
 * append to that base. Socket.io must NOT get the prefix in the URL — `io(url)`
 * reads a URL path as a namespace — so it connects to the origin with the
 * default `/socket.io` path.
 */

/** Strip trailing slashes. */
export const normalizeBase = (url: string) => url.trim().replace(/\/+$/, "");

/** `https://host/api` → `{ origin: "https://host", path: "/api" }`; no path → `path: ""`. */
export function splitApiUrl(base: string): { origin: string; path: string } {
  const b = normalizeBase(base);
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*)?/i.exec(b);
  if (!m) return { origin: b, path: "" };
  return { origin: m[1], path: (m[2] ?? "").replace(/\/+$/, "") };
}

/** Socket.io connection target for an API base URL. */
export function socketTarget(base: string): { url: string; path: string } {
  return { url: splitApiUrl(base).origin, path: "/socket.io" };
}

/**
 * Absolute URL for something the server returned or a path the app builds:
 * absolute / data: URLs pass through; "/uploads/x.png" and "uploads/x.png"
 * resolve against the API base (keeping a gateway prefix like /api).
 */
export function absoluteUrl(base: string, pathOrUrl: string): string {
  if (/^([a-z][a-z0-9+.-]*:)/i.test(pathOrUrl)) return pathOrUrl;
  const b = normalizeBase(base);
  return `${b}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

/**
 * Uploaded media (menu photos, logos) come back as absolute URLs with whatever
 * host the uploader used (`http://localhost:8080/api/uploads/files/abc.jpg`),
 * which a phone can't reach. Anything whose path contains
 * `/uploads/files/<name>` is re-pointed at this app's API base; other absolute
 * URLs pass through, relative paths resolve against the base.
 */
export function rewriteMediaUrl(base: string, url: string): string {
  const m = /\/uploads\/files\/([^/?#]+)([?#].*)?$/.exec(url);
  if (m) return `${normalizeBase(base)}/uploads/files/${m[1]}${m[2] ?? ""}`;
  return absoluteUrl(base, url);
}
