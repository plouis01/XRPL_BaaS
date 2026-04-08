// Indexer entry. Subscribes to XRPL validated ledgers via WebSocket,
// parses transactions into normalized events, and writes derived state
// to PostgreSQL. Powers fast queries that rippled can't (e.g. "all
// credentials issued by account X"). See PLAN.md §5.3.
// TODO Sprint 3.

import './subscriber.ts';

// biome-ignore lint/suspicious/noConsoleLog: bootstrap log before pino is wired
console.log('railforge-indexer started');
