import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  transpilePackages: ["anthus-vultus"],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
