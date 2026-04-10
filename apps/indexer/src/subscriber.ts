// WebSocket subscriber for the XRPL validated ledger stream.
//
// Connects to the configured XRPL_WS_URL, sends the `subscribe` command
// for the `ledger` stream, and emits parsed LedgerClose events via a
// callback. Handles reconnection with exponential backoff so a transient
// rippled restart doesn't kill the indexer process.
//
// The subscriber does NOT parse individual transactions from the stream.
// Sprint 3 scope is ledger-level indexing (close events + high-water mark).
// Transaction-level parsing (for "all credentials issued by X" queries)
// is Sprint 4+ and will use the `transactions_proposed` stream or the
// `ledger` command to fetch full tx sets per closed ledger.

import { Client } from 'xrpl';
import { logger } from './logger.ts';

const log = logger.child({ component: 'subscriber' });

// Reconnect policy: start at 1s, double each attempt, cap at 30s.
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

/**
 * Manages the lifecycle of a single WebSocket connection to rippled's
 * `ledger` stream. Call `start()` to connect and `stop()` to tear down.
 *
 * The subscriber is intentionally a thin pipe — it transforms the raw
 * rippled message into a typed `LedgerCloseEvent` and hands it to the
 * registered handler. The handler (see store.ts) decides what to persist.
 */
export class LedgerSubscriber {
  private client: Client | null = null;
  private handler: LedgerCloseHandler;
  private wsUrl: string;
  private running = false;
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(wsUrl: string, handler: LedgerCloseHandler) {
    this.wsUrl = wsUrl;
    this.handler = handler;
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

      // Reset backoff on successful connect.
      this.reconnectMs = INITIAL_RECONNECT_MS;

      // Subscribe to the ledger stream. rippled pushes a message
      // every time a new ledger closes (~3-5s on mainnet/testnet).
      await this.client.request({
        command: 'subscribe',
        streams: ['ledger'],
      });
      log.info('subscribed to ledger stream');

      // xrpl.js emits 'ledgerClosed' on each validated ledger close.
      // Payload shape: https://xrpl.org/subscribe.html#ledger-stream
      this.client.on('ledgerClosed', (raw) => {
        try {
          const event = this.parseLedgerClose(raw);
          if (event) {
            // Fire-and-forget: the handler (store.ts) owns error handling.
            Promise.resolve(this.handler(event)).catch((err) => {
              log.error({ err }, 'ledger close handler failed');
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
   *
   * Exported as a static for unit testing without a live WebSocket.
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
