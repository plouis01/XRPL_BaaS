// Re-export of the shared logger configured for the API process. The actual
// REDACT_PATHS list lives in @railforge/logger so api/worker/indexer all
// share one source of truth — see SETUP.md note about the logger.
//
// CLAUDE.md rule: never log signed blobs, seeds, or HSM responses. To extend
// the redact list, edit packages/logger/src/index.ts (NOT this file).

import { createLogger } from "@railforge/logger";

export const logger = createLogger({ name: "railforge-api" });
