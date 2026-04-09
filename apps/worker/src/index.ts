// Worker entry point. Spawns BullMQ workers for transaction submission,
// confirmation polling, webhook delivery, credential expiry alerts, and
// reserve reclamation. See PLAN.md §2 (apps/worker tree) and §4.3 pipeline.

import './jobs/credentialExpiry.ts';
import './jobs/reserveReclaimer.ts';
import './jobs/txConfirmer.ts';
import './jobs/txSubmitter.ts';
import './jobs/webhookDelivery.ts';
import { logger } from './logger.ts';

logger.info('railforge-worker started');
