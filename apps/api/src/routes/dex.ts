// DEX service routes. See PLAN.md §7 / ARCHITECTURE.md §4.8.
// OfferCreate, OfferCancel, AMMDeposit, AMMWithdraw, orderbook queries.
//
// POST   /offers                     → create offer
// DELETE /offers/:id                 → cancel offer (id = sequence number)
// GET    /orderbook/:base/:counter   → get orderbook (read-only, 501 until indexer)
// POST   /amm/deposit                → AMM deposit
// POST   /amm/withdraw               → AMM withdraw
// GET    /amm/:asset1/:asset2        → AMM pool info (read-only, 501 until indexer)

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { revocationCheck } from '../middleware/revocationCheck.ts';
import {
  DexServiceError,
  ammDeposit,
  ammWithdraw,
  cancelOffer,
  createOffer,
  toAssetAmount,
  toAssetCurrency,
} from '../services/dex.service.ts';
import type { AppEnv } from '../types.ts';
import {
  ammDepositSchema,
  ammWithdrawSchema,
  cancelOfferSchema,
  createOfferSchema,
} from '../validators/schemas.ts';

const dex = new Hono<AppEnv>();

dex.use('*', revocationCheck);

function dexErrorResponse(err: DexServiceError) {
  switch (err.code) {
    case 'not_found':
      return { error: 'Not found', status: 404 } as const;
    case 'not_managed':
      return { error: err.message, status: 400 } as const;
    case 'invalid_input':
      return { error: err.message, status: 400 } as const;
    case 'enqueue_failed':
      return {
        error: 'Failed to enqueue — please retry',
        status: 503,
      } as const;
    case 'db_conflict':
      return { error: 'Conflict — please retry', status: 409 } as const;
  }
}

// POST /offers — create a new DEX offer
dex.post('/offers', zValidator('json', createOfferSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await createOffer({
      clientId,
      account: body.account,
      takerGets: toAssetAmount(body.taker_gets),
      takerPays: toAssetAmount(body.taker_pays),
      expiration: body.expiration,
      offerSequence: body.offer_sequence,
      flags: body.flags,
      domainId: body.domain_id,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof DexServiceError) {
      const r = dexErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// DELETE /offers/:id — cancel an existing offer
dex.delete('/offers/:id', zValidator('json', cancelOfferSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  const urlId = Number(c.req.param('id'));
  if (Number.isNaN(urlId) || urlId !== body.offer_sequence) {
    return c.json({ error: 'URL :id must match body offer_sequence' }, 400);
  }
  try {
    const result = await cancelOffer({
      clientId,
      account: body.account,
      offerSequence: body.offer_sequence,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof DexServiceError) {
      const r = dexErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /orderbook/:base/:counter — read-only orderbook query
// Requires indexer integration — deferred to Sprint 7.
dex.get('/orderbook/:base/:counter', (c) =>
  c.json({ error: 'Orderbook queries not yet implemented — requires indexer' }, 501),
);

// POST /amm/deposit — deposit liquidity into an AMM pool
dex.post('/amm/deposit', zValidator('json', ammDepositSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await ammDeposit({
      clientId,
      account: body.account,
      asset: toAssetCurrency(body.asset),
      asset2: toAssetCurrency(body.asset2),
      amount: body.amount ? toAssetAmount(body.amount) : undefined,
      amount2: body.amount2 ? toAssetAmount(body.amount2) : undefined,
      ePrice: body.e_price ? toAssetAmount(body.e_price) : undefined,
      lpTokenOut: body.lp_token_out,
      flags: body.flags,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof DexServiceError) {
      const r = dexErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// POST /amm/withdraw — withdraw liquidity from an AMM pool
dex.post('/amm/withdraw', zValidator('json', ammWithdrawSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await ammWithdraw({
      clientId,
      account: body.account,
      asset: toAssetCurrency(body.asset),
      asset2: toAssetCurrency(body.asset2),
      amount: body.amount ? toAssetAmount(body.amount) : undefined,
      amount2: body.amount2 ? toAssetAmount(body.amount2) : undefined,
      ePrice: body.e_price ? toAssetAmount(body.e_price) : undefined,
      lpTokenIn: body.lp_token_in,
      flags: body.flags,
      idempotencyKey: c.req.header('idempotency-key'),
    });
    return c.json(result, 202);
  } catch (err) {
    if (err instanceof DexServiceError) {
      const r = dexErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// GET /amm/:asset1/:asset2 — AMM pool info (read-only)
// Requires indexer integration — deferred to Sprint 7.
dex.get('/amm/:asset1/:asset2', (c) =>
  c.json({ error: 'AMM pool info not yet implemented — requires indexer' }, 501),
);

export default dex;
