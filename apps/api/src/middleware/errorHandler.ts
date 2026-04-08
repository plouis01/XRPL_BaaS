import type { ErrorHandler } from "hono";
import { logger } from "../logger.ts";

export const errorHandler: ErrorHandler = (err, c) => {
  logger.error({ err }, "API error");
  return c.json({ error: err.message || "Internal server error" }, 500);
};
