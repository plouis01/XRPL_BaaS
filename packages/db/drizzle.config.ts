import type { Config } from "drizzle-kit";

// drizzle-kit resolves these paths relative to its CWD, NOT relative to the
// config file. The npm scripts in packages/db cd into this directory before
// invoking drizzle-kit, so relative paths from here are stable.
//
// We also override via cwd in the root scripts (`cd packages/db && bunx
// drizzle-kit ...`) to keep the working directory consistent.

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
