// Account service routes.
//
// POST   /v1/accounts             → create (treasury-funded via tx-submit queue)
// GET    /v1/accounts/:address    → read
// PUT    /v1/accounts/:address/signers       → TODO later this sprint
// DELETE /v1/accounts/:address                → TODO later this sprint
// POST   /v1/accounts/:address/rotate-key     → TODO later this sprint
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
import type { AppEnv } from '../types.ts';
import {
  configureSignersSchema,
  createAccountSchema,
  deleteAccountSchema,
  rotateRegularKeySchema,
} from '../validators/schemas.ts';

const accounts = new Hono<AppEnv>();

accounts.post('/', zValidator('json', createAccountSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');

  try {
    const account = await createAccount({
      clientId,
      label: body.label,
      custodyMode: body.custody_mode,
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
