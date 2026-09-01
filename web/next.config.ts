import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: isDev ? undefined : "export",
  trailingSlash: true,
  transpilePackages: ["anthus-vultus"],
  images: {
    unoptimized: true,
  },
  async rewrites() {
    if (isDev) {
      return [
        {
          source: "/api/:path*",
          destination: "https://wwfo67h32ahlhyaxs23p4rraba0fgxit.lambda-url.us-east-1.on.aws/:path*",
        },
      ];
    }
    return [];
  },
};

export default nextConfig;
