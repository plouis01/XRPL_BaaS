import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "drizzle-kit";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  schema: path.join(here, "src/schema.ts"),
  out: path.join(here, "src/migrations"),
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://railforge:dev-password@localhost:5432/railforge",
  },
  verbose: true,
  strict: true,
} satisfies Config;
