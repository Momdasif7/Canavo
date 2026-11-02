/** @type {import('next').NextConfig} */
const nextConfig = {
  // Overridable so a verification build can run while another server uses .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  transpilePackages: ["@canavo/shared"],
  poweredByHeader: false,
  // The app never uses next/image. Disabling the optimizer removes the
  // /_next/image endpoint and its Next 14 advisories (DoS, SSRF, RCE via SVG/AVIF)
  // until the Next 15.5+ upgrade lands (Phase 3 finding SA-DEP-01).
  images: { unoptimized: true },
};

export default nextConfig;
