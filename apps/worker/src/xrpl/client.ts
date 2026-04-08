// Shared XRPL client pool. Reused across worker jobs.
// See PLAN.md §4.1 — round-robin connections, exponential-backoff reconnect.

import { MAINNET_WS_URLS, TESTNET_WS_URL, type XrplNetwork } from '@railforge/xrpl-core';
import { Client } from 'xrpl';

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 500;

interface PoolEntry {
  client: Client;
  url: string;
  reconnectAttempts: number;
}

export class XrplClientPool {
  private entries: PoolEntry[] = [];
  private index = 0;
  private network: XrplNetwork = 'testnet';

  async initialize(network: XrplNetwork, poolSize = 3): Promise<void> {
    this.network = network;
    const urls = network === 'mainnet' ? Array.from(MAINNET_WS_URLS) : [TESTNET_WS_URL];

    if (urls.length === 0) {
      throw new Error(`No URLs configured for network ${network}`);
    }

    const connectPromises: Promise<void>[] = [];
    for (let i = 0; i < poolSize; i++) {
      const url = urls[i % urls.length] as string;
      const client = new Client(url);
      const entry: PoolEntry = { client, url, reconnectAttempts: 0 };
      this.entries.push(entry);
      this.attachLifecycleHandlers(entry);
      connectPromises.push(client.connect());
    }
    await Promise.all(connectPromises);
  }

  getClient(): Client {
    const first = this.entries[0];
    if (!first) {
      throw new Error('XrplClientPool not initialized — call initialize() first');
    }
    // Find the next connected client; if all are reconnecting, return the
    // first one and let the caller's request fail/retry.
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[this.index];
      this.index = (this.index + 1) % this.entries.length;
      if (entry?.client.isConnected()) {
        return entry.client;
      }
    }
    // No connected clients; return the first as a degraded fallback.
    return first.client;
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.entries.map(async (e) => {
        try {
          await e.client.disconnect();
        } catch {
          // Best-effort during shutdown.
        }
      }),
    );
    this.entries = [];
  }

  private attachLifecycleHandlers(entry: PoolEntry): void {
    entry.client.on('connected', () => {
      entry.reconnectAttempts = 0;
    });

    entry.client.on('disconnected', (code) => {
      // xrpl.js Client emits 'disconnected' on both clean and unclean exits.
      // Code 1000 is a normal close (e.g. shutdown). Anything else triggers
      // exponential-backoff reconnect.
      if (code === 1000) {
        return;
      }
      void this.reconnect(entry);
    });

    entry.client.on('error', (err) => {
      // Surface errors via stderr; the worker process should pipe these to Pino.
      console.error(`[xrpl-pool] ${entry.url} error:`, err);
    });
  }

  private async reconnect(entry: PoolEntry): Promise<void> {
    const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** entry.reconnectAttempts, MAX_BACKOFF_MS);
    entry.reconnectAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, backoff));
    try {
      await entry.client.connect();
    } catch (err) {
      console.error(`[xrpl-pool] reconnect to ${entry.url} failed:`, err);
      void this.reconnect(entry);
    }
  }
}
