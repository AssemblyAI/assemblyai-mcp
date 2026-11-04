import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
  // mcp.assemblyai.com/docs was the docs MCP server before this project took
  // the domain. Proxy it to the docs MCP's current home so old configs keep working.
  async rewrites() {
    return [{ source: "/docs", destination: "https://www.assemblyai.com/docs/mcp" }];
  },
};

export default nextConfig;
