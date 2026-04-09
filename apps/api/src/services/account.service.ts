// Account service — create and read managed XRPL accounts.
//
// Sprint 2 scope: create (faucet-funded) + get by address. Future sprints
// add multi-sign, rotate-key, delete, and treasury-funded creation.
//
// Architecture notes:
//
// - The API process does NOT sign transactions. It only (a) generates a
//   wallet, (b) funds it via the testnet faucet, and (c) persists the seed
//   into accounts.master_key_ref. Signing happens in the worker process,
//   which loads the seed from master_key_ref when needed.
//
// - `master_key_ref` is named for its production meaning: an HSM key
//   handle. In dev (Sprint 2), it holds the raw seed. Sprint 3 replaces
//   this with CloudHSM handles; the column name doesn't change.
//
// - The faucet is a testnet-only funding path. Production uses a treasury
//   wallet pattern (Sprint 3) or XLS-68 sponsored reserves (Sprint 4+).
//
// SECURITY: this service handles seed material. The seed NEVER leaves this
// file via a return value, log line, or API response. It goes directly into
// the DB column and nowhere else. The logger's REDACT_PATHS list covers
// `*.seed` and `*.master_key_ref` in both snake_case and camelCase — see
// packages/logger/src/index.ts.

import { and, db, eq, isNull, schema } from '@railforge/db';
import { Wallet } from 'xrpl';
import { logger } from '../logger.ts';

// Testnet faucet endpoint. Mainnet has no faucet — Sprint 3's treasury
// pattern replaces this.
const TESTNET_FAUCET_URL = 'https://faucet.altnet.rippletest.net/accounts';

export interface CreateAccountInput {
  clientId: string;
  label?: string;
  custodyMode?: 'semi' | 'non_custodial';
}

export interface AccountView {
  id: string;
  address: string;
  regularKey: string | null;
  custodyMode: string;
  label: string | null;
  isFunded: boolean;
  reserveBalance: string;
  createdAt: Date | null;
}

export class AccountServiceError extends Error {
  constructor(
    public readonly code: 'faucet_failed' | 'faucet_bad_response' | 'not_found' | 'db_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'AccountServiceError';
  }
}

/**
 * Generate a new wallet, fund it via the testnet faucet, and persist it.
 * Returns a redacted AccountView — the seed is NEVER in the response.
 *
 * @throws {AccountServiceError} on faucet failure or DB conflict
 */
export async function createAccount(input: CreateAccountInput): Promise<AccountView> {
  const log = logger.child({
    service: 'account',
    op: 'create',
    clientId: input.clientId,
  });

  // 1. Generate a wallet. We use xrpl.js's Wallet.generate() directly so
  // the API doesn't depend on the worker's signer module. The seed lives
  // on this stack frame briefly, goes into master_key_ref, and disappears.
  const wallet = Wallet.generate();
  if (!wallet.seed) {
    throw new Error('Wallet.generate() returned no seed — should never happen');
  }
  const address = wallet.classicAddress;

  // 2. Fund via the testnet faucet. The faucet takes a `destination` in
  // its POST body to fund an existing address rather than generating a
  // fresh one, which is what we want since we need the seed.
  let reserveBalance = '0';
  let isFunded = false;
  try {
    const response = await fetch(TESTNET_FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destination: address }),
      // 30s timeout — the faucet is occasionally slow but shouldn't hang.
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      log.error({ status: response.status, body: bodyText }, 'faucet non-200');
      throw new AccountServiceError('faucet_failed', `Faucet returned ${response.status}`);
    }

    const body = (await response.json()) as {
      account?: { address?: string };
      balance?: number;
    };

    // Sanity check the address matches — defends against a faucet bug
    // that would otherwise leave us with a seed for a different account.
    if (body.account?.address && body.account.address !== address) {
      throw new AccountServiceError(
        'faucet_bad_response',
        'Faucet returned an address that does not match the one we requested',
      );
    }

    isFunded = true;
    // Faucet returns balance in XRP. Store as drops-string for consistency
    // with reserve_balance elsewhere. 1 XRP = 1_000_000 drops.
    if (typeof body.balance === 'number') {
      reserveBalance = String(Math.round(body.balance * 1_000_000));
    }
    log.info({ address, balance: body.balance }, 'faucet funded');
  } catch (err) {
    if (err instanceof AccountServiceError) throw err;
    log.error({ err }, 'faucet request failed');
    throw new AccountServiceError(
      'faucet_failed',
      err instanceof Error ? err.message : 'unknown faucet error',
    );
  }

  // 3. Persist. master_key_ref holds the seed (see file-level comment).
  // The UNIQUE constraint on accounts.address is the collision detector
  // — astronomically unlikely (2^-128) but we handle it cleanly if it ever
  // happens (e.g. a test re-generating with a seeded PRNG).
  let insertedId: string;
  try {
    const inserted = await db
      .insert(schema.accounts)
      .values({
        clientId: input.clientId,
        address,
        masterKeyRef: wallet.seed,
        regularKey: null,
        custodyMode: input.custodyMode ?? 'semi',
        label: input.label ?? null,
        isFunded,
        reserveBalance,
        metadata: {},
      })
      .returning({ id: schema.accounts.id });

    const row = inserted[0];
    if (!row) {
      throw new AccountServiceError('db_conflict', 'insert returned no row');
    }
    insertedId = row.id;
  } catch (err) {
    // Postgres unique-violation error code 23505.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new AccountServiceError('db_conflict', 'Address collision (retry)');
    }
    throw err;
  }

  // 4. Return a redacted view — seed is NEVER in the response.
  return {
    id: insertedId,
    address,
    regularKey: null,
    custodyMode: input.custodyMode ?? 'semi',
    label: input.label ?? null,
    isFunded,
    reserveBalance,
    createdAt: new Date(),
  };
}

/**
 * Look up an account by address, scoped to a client. Returns null if the
 * account doesn't exist OR belongs to a different client — the two cases
 * are indistinguishable to the caller, which is intentional (no cross-
 * tenant enumeration).
 */
export async function getAccount(clientId: string, address: string): Promise<AccountView | null> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      address: schema.accounts.address,
      regularKey: schema.accounts.regularKey,
      custodyMode: schema.accounts.custodyMode,
      label: schema.accounts.label,
      isFunded: schema.accounts.isFunded,
      reserveBalance: schema.accounts.reserveBalance,
      createdAt: schema.accounts.createdAt,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.clientId, clientId),
        eq(schema.accounts.address, address),
        isNull(schema.accounts.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    address: row.address,
    regularKey: row.regularKey,
    custodyMode: row.custodyMode,
    label: row.label,
    isFunded: row.isFunded ?? false,
    reserveBalance: row.reserveBalance ?? '0',
    createdAt: row.createdAt,
  };
}
