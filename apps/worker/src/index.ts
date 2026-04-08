// Worker entry point. Spawns BullMQ workers for transaction submission,
// confirmation polling, webhook delivery, credential expiry alerts, and
// reserve reclamation. See PLAN.md §2 (apps/worker tree) and §4.3 pipeline.

import "./jobs/txSubmitter.ts";
import "./jobs/txConfirmer.ts";
import "./jobs/webhookDelivery.ts";
import "./jobs/credentialExpiry.ts";
import "./jobs/reserveReclaimer.ts";

console.log("railforge-worker started");
