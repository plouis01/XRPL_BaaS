// Account service routes.
//
// POST   /v1/accounts             → create (treasury-funded via tx-submit queue)
// GET    /v1/accounts/:address    → read
// PUT    /v1/accounts/:address/signers       → configure multi-sign
// DELETE /v1/accounts/:address                → delete account
// POST   /v1/accounts/:address/rotate-key     → rotate regular key
//
// Middleware order (set in apps/api/src/index.ts):
//   ipRateLimit → auth → rateLimit → idempotency → this handler
// So by the time a handler runs, clientId is on the context.
//
// Sprint 3 contract change: POST /v1/accounts returns is_funded=false and
// a funding_tx_id. Clients poll GET /v1/accounts/:address to observe the
// flip once the treasury payment validates (~4s under normal load).

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  AccountServiceError,
  configureSigners,
  createAccount,
  deleteAccount,
  getAccount,
  rotateRegularKey,
} from '../services/account.service.ts';
import { listCredentialsForAccount } from '../services/credential.service.ts';
import type { AppEnv } from '../types.ts';
import {
  configureSignersSchema,
  createAccountSchema,
  deleteAccountSchema,
  rotateRegularKeySchema,
} from '../validators/schemas.ts';
import { getReadClient } from '../xrpl/readClient.ts';

const accounts = new Hono<AppEnv>();

// REVIEW.md LOW-03: revocationCheck is mounted globally on /v1 — no
// per-router duplicate.

accounts.post('/', zValidator('json', createAccountSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');

  try {
    const account = await createAccount({
      clientId,
      label: body.label,
      custodyMode: body.custody_mode,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    // Response shape matches PLAN.md §4.5 — snake_case for wire format.
    return c.json(
      {
        id: account.id,
        address: account.address,
        regular_key: account.regularKey,
        custody_mode: account.custodyMode,
        label: account.label,
        is_funded: account.isFunded,
        reserve_balance: account.reserveBalance,
        funding_tx_id: account.fundingTxId,
        created_at: account.createdAt,
      },
      201,
    );
  } catch (err) {
    if (err instanceof AccountServiceError) {
      if (err.code === 'treasury_not_configured') {
        // 503: the server is temporarily unable to service the request
        // because its treasury isn't configured. This is an operator
        // problem, not a client problem, so we don't surface details.
        return c.json({ error: 'Account creation is currently unavailable' }, 503);
      }
      if (err.code === 'enqueue_failed') {
        // 503: the DB row exists but we couldn't queue the funding tx.
        // The client should retry; the orphaned account row will be
        // cleaned up by a future reconciliation job.
        return c.json({ error: 'Failed to enqueue account funding — please retry' }, 503);
      }
      if (err.code === 'db_conflict') {
        return c.json({ error: 'Address collision — please retry' }, 409);
      }
    }
    throw err; // let the global error handler deal with unexpected failures
  }
});

accounts.get('/:address', async (c) => {
  const clientId = c.get('clientId');
  const address = c.req.param('address');

  const account = await getAccount(clientId, address);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  return c.json({
    id: account.id,
    address: account.address,
    regular_key: account.regularKey,
    custody_mode: account.custodyMode,
    label: account.label,
    is_funded: account.isFunded,
    reserve_balance: account.reserveBalance,
    funding_tx_id: account.fundingTxId,
    created_at: account.createdAt,
  });
});

// GET /:address/balances — live rippled balances snapshot (PLAN.md §9.2 G-4).
// Scope: XRP (account_info), trust-line balances (account_lines), MPTs
// (account_objects filtered to MPToken). Authoritative — no indexer lag.
accounts.get('/:address/balances', async (c) => {
  const clientId = c.get('clientId');
  const address = c.req.param('address');

  const account = await getAccount(clientId, address);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  const client = await getReadClient();

  // XRP balance via account_info. If the account doesn't exist on-ledger
  // (e.g. treasury funding hasn't confirmed), rippled returns actNotFound.
  let xrpDrops = '0';
  try {
    const info = (await client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'validated',
    })) as { result: { account_data?: { Balance?: string } } };
    xrpDrops = info.result.account_data?.Balance ?? '0';
  } catch (err) {
    const e = err as { data?: { error?: string } };
    if (e?.data?.error !== 'actNotFound') throw err;
  }

  // Trust-line balances.
  let trustlines: Array<{ currency: string; issuer: string; balance: string }> = [];
  try {
    const lines = (await client.request({
      command: 'account_lines',
      account: address,
      ledger_index: 'validated',
    })) as {
      result: {
        lines?: Array<{ currency: string; account: string; balance: string }>;
      };
    };
    trustlines = (lines.result.lines ?? []).map((l) => ({
      currency: l.currency,
      issuer: l.account,
      balance: l.balance,
    }));
  } catch (err) {
    const e = err as { data?: { error?: string } };
    if (e?.data?.error !== 'actNotFound') throw err;
  }

  // MPT balances via account_objects filtered to MPToken entries.
  let mpts: Array<{ mpt_issuance_id: string; balance: string }> = [];
  try {
    const objs = (await client.request({
      command: 'account_objects',
      account: address,
      type: 'mptoken',
      ledger_index: 'validated',
    })) as {
      result: {
        account_objects?: Array<{
          MPTokenIssuanceID?: string;
          MPTAmount?: string;
        }>;
      };
    };
    mpts = (objs.result.account_objects ?? [])
      .filter((o) => typeof o.MPTokenIssuanceID === 'string')
      .map((o) => ({
        mpt_issuance_id: o.MPTokenIssuanceID as string,
        balance: o.MPTAmount ?? '0',
      }));
  } catch (err) {
    const e = err as { data?: { error?: string } };
    if (e?.data?.error !== 'actNotFound') throw err;
  }

  return c.json({
    address,
    xrp_drops: xrpDrops,
    trustlines,
    mpts,
  });
});

// GET /:address/credentials — list all credentials for a managed account.
// Paginated per REVIEW.md H-4. Query params: ?limit=N&offset=M.
accounts.get('/:address/credentials', async (c) => {
  const clientId = c.get('clientId');
  const address = c.req.param('address');

  const account = await getAccount(clientId, address);
  if (!account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  const limitParam = c.req.query('limit');
  const offsetParam = c.req.query('offset');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const offset = offsetParam ? Number.parseInt(offsetParam, 10) : undefined;
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1 || limit > 1000)) {
    return c.json({ error: 'limit must be an integer between 1 and 1000' }, 400);
  }
  if (offset !== undefined && (Number.isNaN(offset) || offset < 0)) {
    return c.json({ error: 'offset must be a non-negative integer' }, 400);
  }

  const result = await listCredentialsForAccount(clientId, address, {
    limit,
    offset,
  });
  return c.json(result);
});

// Map an AccountServiceError to its HTTP response. Centralized so the
// handlers below stay readable.
function accountErrorResponse(err: AccountServiceError) {
  switch (err.code) {
    case 'not_found':
      return { error: 'Account not found', status: 404 } as const;
    case 'account_not_funded':
      // 409: the account row exists but the on-ledger funding payment
      // hasn't validated yet, so subsequent ops can't reference it.
      return { error: err.message, status: 409 } as const;
    case 'invalid_input':
      return { error: err.message, status: 400 } as const;
    case 'treasury_not_configured':
      return {
        error: 'Account creation is currently unavailable',
        status: 503,
      } as const;
    case 'enqueue_failed':
      return {
        error: 'Failed to enqueue — please retry',
        status: 503,
      } as const;
    case 'db_conflict':
      return {
        error: 'Address collision — please retry',
        status: 409,
      } as const;
  }
}

accounts.put('/:address/signers', zValidator('json', configureSignersSchema), async (c) => {
  const clientId = c.get('clientId');
  const address = c.req.param('address');
  const body = c.req.valid('json');
  try {
    const result = await configureSigners({
      clientId,
      address,
      quorum: body.quorum,
      signers: body.signers,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof AccountServiceError) {
      const r = accountErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

accounts.post('/:address/rotate-key', zValidator('json', rotateRegularKeySchema), async (c) => {
  const clientId = c.get('clientId');
  const address = c.req.param('address');
  const body = c.req.valid('json');
  try {
    const result = await rotateRegularKey({
      clientId,
      address,
      // body.regular_key may be undefined (omitted) — treat as null (clear).
      regularKey: body.regular_key ?? null,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof AccountServiceError) {
      const r = accountErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

accounts.delete('/:address', zValidator('json', deleteAccountSchema), async (c) => {
  const clientId = c.get('clientId');
  const address = c.req.param('address');
  const body = c.req.valid('json');
  try {
    const result = await deleteAccount({
      clientId,
      address,
      destination: body.destination,
      destinationTag: body.destination_tag,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof AccountServiceError) {
      const r = accountErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

export default accounts;
