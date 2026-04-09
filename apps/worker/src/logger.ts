// Re-export of the shared logger configured for the worker process. See
// apps/api/src/logger.ts for the rationale and CLAUDE.md rules.

import { createLogger } from "@railforge/logger";

export const logger = createLogger({ name: "railforge-worker" });
