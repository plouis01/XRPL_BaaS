// Distributed sequence-number coordinator. Prevents two workers from grabbing
// the same Sequence for one account. See PLAN.md §4.2.
// CRITICAL: never bypass this — direct client.submit() in route handlers is a bug.
// TODO Sprint 1: implement against ioredis with `SET NX EX` locking.

import type { Redis } from "ioredis";
import type { XrplClientPool } from "./client.ts";

export class TxSequencer {
  constructor(
    private redis: Redis,
    private xrplPool: XrplClientPool,
  ) {}

  async getNextSequence(_address: string): Promise<number> {
    // TODO
    throw new Error("not implemented");
  }

  async invalidate(_address: string): Promise<void> {
    // TODO
  }
}
