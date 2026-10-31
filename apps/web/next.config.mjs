/** @type {import('next').NextConfig} */
const nextConfig = {
  // Overridable so a verification build can run while another server uses .next
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  transpilePackages: ["@canavo/shared"],
  poweredByHeader: false,
};

export default nextConfig;
