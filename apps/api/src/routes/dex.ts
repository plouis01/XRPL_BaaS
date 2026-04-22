// DEX service routes. See PLAN.md §7 / ARCHITECTURE.md §4.8.
// OfferCreate, OfferCancel, AMMDeposit, AMMWithdraw, orderbook queries.
//
// POST   /offers                     → create offer
// DELETE /offers/:id                 → cancel offer (id = sequence number)
// GET    /orderbook/:base/:counter   → get orderbook (live rippled query)
// POST   /amm/deposit                → AMM deposit
// POST   /amm/withdraw               → AMM withdraw
// GET    /amm/:asset1/:asset2        → AMM pool info (live rippled query)

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { dexReadRateLimit } from '../middleware/dexReadRateLimit.ts';
import { AssetParseError, parseAssetParam, rippledAssetSpec } from '../services/assetQuery.ts';
import {
  DexServiceError,
  ammDeposit,
  ammWithdraw,
  cancelOffer,
  createOffer,
  toAssetAmount,
  toAssetCurrency,
} from '../services/dex.service.ts';
import { OrderbookSourceError, readOrderbookFromIndexer } from '../services/orderbookQuery.ts';
import type { AppEnv } from '../types.ts';
import {
  ammDepositSchema,
  ammWithdrawSchema,
  cancelOfferSchema,
  createOfferSchema,
} from '../validators/schemas.ts';
import { getReadClient } from '../xrpl/readClient.ts';

const dex = new Hono<AppEnv>();

// REVIEW.md LOW-03: revocationCheck is mounted globally on /v1 — no
// per-router duplicate.

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

// GET /orderbook/:base/:counter — orderbook read.
// Sources:
//   default         → live rippled `book_offers` (authoritative)
//   ?source=indexer → indexer's offer_book cache (fast, as fresh as the HWM)
// Optional ?limit= (default 50, max 400).
// REVIEW.md MED-09: tighter rate limit on the read routes to stop a
// free-tier key from scraping XRPL through rippled + our bandwidth.
dex.get('/orderbook/:base/:counter', dexReadRateLimit, async (c) => {
  try {
    const base = parseAssetParam(c.req.param('base'));
    const counter = parseAssetParam(c.req.param('counter'));
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
    if (Number.isNaN(limit) || limit < 1 || limit > 400) {
      return c.json({ error: 'limit must be an integer between 1 and 400' }, 400);
    }

    const source = c.req.query('source') ?? 'rippled';
    if (source === 'indexer') {
      const result = await readOrderbookFromIndexer(base, counter, limit);
      return c.json(result);
    }
    if (source !== 'rippled') {
      return c.json({ error: 'source must be "rippled" (default) or "indexer"' }, 400);
    }

    const client = await getReadClient();
    const resp = (await client.request({
      command: 'book_offers',
      taker_gets: rippledAssetSpec(base),
      taker_pays: rippledAssetSpec(counter),
      limit,
    })) as { result: { offers?: unknown[]; ledger_index?: number } };
    return c.json({
      offers: resp.result.offers ?? [],
      ledger_index: resp.result.ledger_index ?? null,
      source: 'rippled' as const,
    });
  } catch (err) {
    if (err instanceof AssetParseError) return c.json({ error: err.message }, 400);
    if (err instanceof OrderbookSourceError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
});

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

// GET /amm/:asset1/:asset2 — live rippled `amm_info` query.
dex.get('/amm/:asset1/:asset2', dexReadRateLimit, async (c) => {
  try {
    const asset1 = parseAssetParam(c.req.param('asset1'));
    const asset2 = parseAssetParam(c.req.param('asset2'));
    const client = await getReadClient();
    const resp = (await client.request({
      command: 'amm_info',
      asset: rippledAssetSpec(asset1),
      asset2: rippledAssetSpec(asset2),
    })) as { result: { amm?: unknown; ledger_index?: number } };
    if (!resp.result.amm) {
      return c.json({ error: 'AMM pool not found for the given asset pair' }, 404);
    }
    return c.json({
      amm: resp.result.amm,
      ledger_index: resp.result.ledger_index ?? null,
    });
  } catch (err) {
    if (err instanceof AssetParseError) return c.json({ error: err.message }, 400);
    // rippled returns an error object when the pool doesn't exist — catch
    // the xrpl.js exception wrapping it and surface as 404.
    const e = err as { data?: { error?: string }; message?: string };
    if (e?.data?.error === 'actNotFound' || e?.message?.includes('actNotFound')) {
      return c.json({ error: 'AMM pool not found for the given asset pair' }, 404);
    }
    throw err;
  }
});

export default dex;
