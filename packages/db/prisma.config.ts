import "dotenv/config";
import { defineConfig } from "prisma/config";

/** Placeholder for `prisma generate` when DATABASE_URL is unset (e.g. CI). */
const datasourceUrl =
  process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: datasourceUrl,
  },
});
