import path from "node:path";
import type { NextConfig } from "next";

// Three build targets:
//   default            — dev / `next start` (Docker sets NEXT_OUTPUT=standalone)
//   NEXT_OUTPUT=standalone — self-contained Node server for the Docker image
//   NEXT_EXPORT=1      — fully static export for GitHub Pages / any static host
const isExport = process.env.NEXT_EXPORT === "1";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  output: isExport
    ? "export"
    : process.env.NEXT_OUTPUT === "standalone"
      ? "standalone"
      : undefined,
  // Project pages are served from /<repo>; user sites and custom domains from /.
  basePath: basePath || undefined,
  // Static hosts resolve /metrics to /metrics/index.html.
  trailingSlash: isExport ? true : undefined,
  images: { unoptimized: isExport },
  outputFileTracingRoot: path.join(__dirname),
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },
};

export default nextConfig;
