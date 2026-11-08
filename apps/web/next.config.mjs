/**
 * Security headers (QA phase 8). The API origin comes from NEXT_PUBLIC_API_URL (baked in at build time);
 * "/api" (same-origin gateway) needs nothing beyond 'self'.
 * script-src keeps 'unsafe-inline': the App Router streams inline hydration scripts and the layout has two
 * small inline init scripts; a nonce would need middleware and fully dynamic rendering.
 */
const isDev = process.env.NODE_ENV !== "production";

function apiOrigins() {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  if (raw.startsWith("/")) return [];
  try {
    const u = new URL(raw);
    return [u.origin, `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`];
  } catch {
    return [];
  }
}

const api = apiOrigins();
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Uploaded images (API storage / Cloudinary), map tiles, QR codes, blob previews
  `img-src 'self' data: blob: https:${api[0] ? ` ${api[0]}` : ""}`,
  "font-src 'self' data:",
  ["connect-src 'self'", ...api, "https://nominatim.openstreetmap.org", ...(isDev ? ["ws:", "wss:"] : [])].join(" "),
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera: inventory barcode scanner. Geolocation: delivery pins and partner runs.
  {
    key: "Permissions-Policy",
    value: "camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), serial=(), bluetooth=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Browsers ignore HSTS over plain http (LAN / gateway); it takes effect once served over https.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Overridable so a verification build can run while another server uses .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  transpilePackages: ["@canavo/shared"],
  poweredByHeader: false,
  // next/image is not used: disabling the optimizer makes /_next/image return 404, which removes the
  // Next 14 Image Optimization API advisories (GHSA-2464-fhr4-w9xw, GHSA-2xp9-vwfh-vxw4, GHSA-h64f-5h5j-jqjh, ...).
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
