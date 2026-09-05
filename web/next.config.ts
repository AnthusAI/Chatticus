import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: isDev ? undefined : "export",
  trailingSlash: true,
  transpilePackages: ["anthus-vultus"],
  images: {
    unoptimized: true,
  },
  async redirects() {
    if (!isDev) {
      return [];
    }
    // Local dev only: production's CloudFront function rewrites / -> /chat
    // before the static export is ever consulted (marketing moved to its
    // own repo, chatticus-3926bc, so there is no app/page.tsx for / to
    // fall back to). next dev has no CloudFront in front of it.
    return [{ source: "/", destination: "/chat", permanent: false }];
  },
  async rewrites() {
    if (!isDev) {
      return [];
    }
    // Local dev only: proxy /api to a named stack. Set CHATTICUS_DEV_API_ORIGIN
    // (e.g. https://dev.chattic.us/api) or CHATTICUS_DEVELOPMENT_BASE_URL in .env.local.
    const base =
      process.env.CHATTICUS_DEV_API_ORIGIN?.replace(/\/$/, "") ??
      process.env.CHATTICUS_DEVELOPMENT_BASE_URL?.replace(/\/$/, "");
    if (!base) {
      return [];
    }
    return [
      {
        source: "/api/:path*",
        destination: `${base}/:path*`,
      },
    ];
  },
};

export default nextConfig;
