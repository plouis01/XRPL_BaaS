// Indexer entry. Subscribes to XRPL validated ledgers via WebSocket,
// parses transactions into normalized events, and writes derived state
// to PostgreSQL. Powers fast queries that rippled can't (e.g. "all
// credentials issued by account X"). See PLAN.md §5.3.
// TODO Sprint 3.

import { logger } from "./logger.ts";
import "./subscriber.ts";

logger.info("railforge-indexer started");
