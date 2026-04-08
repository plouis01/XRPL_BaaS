import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://railforge:dev-password@localhost:5432/railforge",
  },
  verbose: true,
  strict: true,
} satisfies Config;
