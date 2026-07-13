import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./postgres-migrations",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://needle:needle@127.0.0.1:5432/needle",
  },
});
