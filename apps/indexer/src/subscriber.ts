// WebSocket subscriber for the XRPL validated ledger stream.
//
// Connects to the configured XRPL_WS_URL, sends the `subscribe` command
// for the `ledger` stream, and emits two kinds of events:
//
//   1. ledger close    → LedgerCloseEvent (ledger-level high-water mark)
//   2. validated tx    → raw tx payload (one per tx in the just-closed ledger)
//
// Option-B per-tx fetch: rather than subscribing to the firehose
// `transactions` stream, we wait for each `ledgerClosed` then issue a
// single `ledger` command with `transactions: true, expand: true`. This
// gives us a deterministic, replayable per-ledger batch keyed by the
// ledger index. Replay-on-restart is trivial — the indexer reads the
// high-water mark, then fetches every ledger from hwm+1 to current.
//
// Reconnect policy: exponential backoff 1s → 30s. The existing reconnect
// test (subscriber.reconnect.test.ts) covers the lifecycle.

import { Client } from 'xrpl';
import { logger } from './logger.ts';

const log = logger.child({ component: 'subscriber' });

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export interface LedgerCloseEvent {
  /** Validated ledger index (monotonically increasing). */
  ledgerIndex: number;
  /** Ledger hash (hex). */
  ledgerHash: string;
  /** Close time in XRPL epoch seconds. */
  closeTime: number;
  /** Number of transactions in this ledger. */
  txCount: number;
}

export type LedgerCloseHandler = (event: LedgerCloseEvent) => void | Promise<void>;
export type TransactionHandler = (raw: unknown) => void | Promise<void>;

export interface SubscriberHandlers {
  onLedgerClose: LedgerCloseHandler;
  /**
   * Called once per validated transaction in each closed ledger. The
   * payload shape matches what `ledger` returns with `expand: true`:
   * the tx fields with a sibling `meta` (or `metaData`) object and a
   * top-level `hash` + `ledger_index`.
   */
  onTransaction?: TransactionHandler;
}

/**
 * Manages a single WebSocket connection to rippled's `ledger` stream
 * and per-ledger tx fetches. Call `start()` to connect, `stop()` to
 * tear down.
 */
export class LedgerSubscriber {
  private client: Client | null = null;
  private handlers: SubscriberHandlers;
  private wsUrl: string;
  private running = false;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(wsUrl: string, handlers: SubscriberHandlers | LedgerCloseHandler) {
    this.wsUrl = wsUrl;
    // Backwards-compat: if passed a bare function, treat it as
    // onLedgerClose only. Existing callers (reconnect test) rely on this.
    this.handlers = typeof handlers === 'function' ? { onLedgerClose: handlers } : handlers;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client?.isConnected()) {
      try {
        await this.client.disconnect();
      } catch {
        // Best-effort — the process is shutting down anyway.
      }
    }
    this.client = null;
    log.info('subscriber stopped');
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    try {
      this.client = new Client(this.wsUrl);

      this.client.on('disconnected', (code: number) => {
        log.warn({ code }, 'WebSocket disconnected');
        this.scheduleReconnect();
      });

      this.client.on('error', (err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'WebSocket error');
      });

      await this.client.connect();
      log.info({ wsUrl: this.wsUrl }, 'connected to rippled');

      this.reconnectMs = INITIAL_RECONNECT_MS;

      await this.client.request({
        command: 'subscribe',
        streams: ['ledger'],
      });
      log.info('subscribed to ledger stream');

      this.client.on('ledgerClosed', (raw) => {
        try {
          const event = this.parseLedgerClose(raw);
          if (!event) return;
          // Fire ledger-close handler first; don't await — the tx fetch
          // happens in parallel so a slow DB write on the store side
          // doesn't block the next ledger.
          Promise.resolve(this.handlers.onLedgerClose(event)).catch((err) => {
            log.error({ err }, 'ledger close handler failed');
          });
          // Per-tx fan-out (optional).
          if (this.handlers.onTransaction) {
            this.fetchAndEmitTransactions(event.ledgerIndex).catch((err) => {
              log.error({ err, ledgerIndex: event.ledgerIndex }, 'tx fetch failed');
            });
          }
        } catch (err) {
          log.error({ err }, 'failed to parse ledger close event');
        }
      });
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to connect to rippled',
      );
      this.scheduleReconnect();
    }
  }

  private async fetchAndEmitTransactions(ledgerIndex: number): Promise<void> {
    const handler = this.handlers.onTransaction;
    if (!handler || !this.client) return;
    const resp = (await this.client.request({
      command: 'ledger',
      ledger_index: ledgerIndex,
      transactions: true,
      expand: true,
    })) as { result: { ledger?: { transactions?: unknown[] } } };
    const txs = resp.result.ledger?.transactions ?? [];
    for (const tx of txs) {
      // Rippled omits ledger_index inside each expanded tx entry — thread
      // it through so the parser has it.
      const enriched =
        tx && typeof tx === 'object'
          ? { ...(tx as Record<string, unknown>), ledger_index: ledgerIndex }
          : tx;
      try {
        await handler(enriched);
      } catch (err) {
        log.error({ err, ledgerIndex }, 'tx handler failed');
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    log.info({ delayMs: this.reconnectMs }, 'scheduling reconnect');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.client) {
        try {
          await this.client.disconnect();
        } catch {
          // Old connection may already be dead.
        }
        this.client = null;
      }
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
      await this.connect();
    }, this.reconnectMs);
  }

  /**
   * Parse a raw rippled ledgerClosed event into our typed shape.
   * Returns null if the message is malformed (log + skip, never throw).
   */
  parseLedgerClose(raw: unknown): LedgerCloseEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const msg = raw as Record<string, unknown>;

    const ledgerIndex = msg.ledger_index;
    const ledgerHash = msg.ledger_hash;
    const closeTime = msg.ledger_time;
    const txCount = msg.txn_count;

    if (
      typeof ledgerIndex !== 'number' ||
      typeof ledgerHash !== 'string' ||
      typeof closeTime !== 'number'
    ) {
      log.warn({ raw }, 'malformed ledger close event');
      return null;
    }

    return {
      ledgerIndex,
      ledgerHash,
      closeTime,
      txCount: typeof txCount === 'number' ? txCount : 0,
    };
  }
}
