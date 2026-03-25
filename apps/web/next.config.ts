import type { NextConfig } from "next";
import fs from "fs";
import path from "path";
import { config as loadEnvFile } from "dotenv";

// Monorepo: merge env before Next reads `NEXT_PUBLIC_*` (Clerk, etc.).
// Order: repo root first, then `apps/web` (so app-local overrides root).
const monorepoRoot = path.resolve(__dirname, "../..");
const webAppRoot = path.resolve(__dirname, ".");
for (const name of [".env.local", ".env"] as const) {
  for (const base of [monorepoRoot, webAppRoot]) {
    const file = path.join(base, name);
    if (fs.existsSync(file)) {
      loadEnvFile({ path: file });
    }
  }
}

const nextConfig: NextConfig = {
  // Ensure monorepo-loaded env is visible to the client bundle (Clerk Frontend API calls).
  env: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "",
  },
  transpilePackages: ["@shifthub/api", "@shifthub/db", "@shifthub/validators"],
  // @shifthub/db imports Prisma's generated `./client.js` while the file on disk is `client.ts`
  // (valid for Node ESM + tsc). Map `.js` → `.ts` so the bundler resolves the generated client.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  turbopack: {
    resolveAlias: {
      [path.join(monorepoRoot, "packages/db/src/generated/prisma/client.js")]: path.join(
        monorepoRoot,
        "packages/db/src/generated/prisma/client.ts",
      ),
    },
  },
};

export default nextConfig;
