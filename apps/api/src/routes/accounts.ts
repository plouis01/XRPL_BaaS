// Account service routes.
//
// POST   /v1/accounts             → create (faucet-funded in Sprint 2)
// GET    /v1/accounts/:address    → read
// PUT    /v1/accounts/:address/signers       → TODO later this sprint
// DELETE /v1/accounts/:address                → TODO later this sprint
// POST   /v1/accounts/:address/rotate-key     → TODO later this sprint
//
// Middleware order (set in apps/api/src/index.ts):
//   ipRateLimit → auth → rateLimit → idempotency → this handler
// So by the time a handler runs, clientId is on the context.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { AccountServiceError, createAccount, getAccount } from '../services/account.service.ts';
import type { AppEnv } from '../types.ts';
import { createAccountSchema } from '../validators/schemas.ts';

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
        created_at: account.createdAt,
      },
      201,
    );
  } catch (err) {
    if (err instanceof AccountServiceError) {
      if (err.code === 'faucet_failed' || err.code === 'faucet_bad_response') {
        return c.json({ error: 'Failed to fund account from testnet faucet' }, 503);
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
    created_at: account.createdAt,
  });
});

// TODO Sprint 2: multi-sign, rotate-key, delete
accounts.put('/:address/signers', (c) => c.json({ error: 'not implemented' }, 501));
accounts.delete('/:address', (c) => c.json({ error: 'not implemented' }, 501));
accounts.post('/:address/rotate-key', (c) => c.json({ error: 'not implemented' }, 501));

export default accounts;
