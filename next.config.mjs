import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.resolve.alias["@hosted"] = path.join(__dirname, "hosted");
    config.resolve.alias["@back"] = path.join(__dirname, "back");
    config.resolve.alias["@shared"] = path.join(__dirname, "shared/types");
    return config;
  },
};

export default nextConfig;
