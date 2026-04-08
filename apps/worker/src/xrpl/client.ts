// Shared XRPL client pool. Reused across worker jobs.
// See PLAN.md §4.1 — round-robin connections, exponential-backoff reconnect.
// TODO Sprint 1: implement against xrpl.js Client.

import type { Client } from "xrpl";

export class XrplClientPool {
  private clients: Client[] = [];
  private index = 0;

  async initialize(
    _network: "mainnet" | "testnet",
    _poolSize = 3,
  ): Promise<void> {
    // TODO
  }

  getClient(): Client {
    if (this.clients.length === 0) {
      throw new Error("XrplClientPool not initialized");
    }
    const client = this.clients[this.index]!;
    this.index = (this.index + 1) % this.clients.length;
    return client;
  }
}
