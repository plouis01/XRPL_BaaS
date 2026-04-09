// Token service routes.
//
// POST   /v1/tokens              → create (MPT default, trustline opt-in)
// POST   /v1/tokens/:id/transfer → transfer issuer-held token to a holder
// PUT    /v1/tokens/:id/freeze   → lock/unlock the issuance (MPT only for now)
// PUT    /v1/tokens/:id/clawback → reclaim tokens from a holder

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  TokenServiceError,
  clawbackToken,
  createToken,
  freezeToken,
  transferToken,
} from '../services/token.service.ts';
import type { AppEnv } from '../types.ts';
import {
  clawbackTokenSchema,
  createTokenSchema,
  freezeTokenSchema,
  transferTokenSchema,
} from '../validators/schemas.ts';

const tokens = new Hono<AppEnv>();

// Map a TokenServiceError to its HTTP response. Centralized so the four
// handlers below stay readable and we don't drift on which code returns
// which status.
function tokenErrorResponse(err: TokenServiceError) {
  switch (err.code) {
    case 'issuer_not_found':
      return { error: 'Issuer account not found', status: 404 } as const;
    case 'token_not_found':
      return { error: 'Token not found', status: 404 } as const;
    case 'token_not_ready':
      // 409: the token row exists but the on-ledger issuance hasn't
      // validated yet, so MPT operations can't reference it.
      return { error: err.message, status: 409 } as const;
    case 'trustline_missing_limit':
      return { error: err.message, status: 400 } as const;
    case 'invalid_input':
      return { error: err.message, status: 400 } as const;
  }
}

tokens.post('/', zValidator('json', createTokenSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');

  try {
    const token = await createToken({
      clientId,
      issuer: body.issuer,
      type: body.type,
      currencyCode: body.currency_code,
      transferFee: body.transfer_fee,
      clawback: body.clawback,
      freezeEnabled: body.freeze_enabled,
      maxSupply: body.max_supply,
      metadata: body.metadata,
      trustlineLimit: body.trustline_limit,
    });

    return c.json(
      {
        id: token.id,
        issuer_address: token.issuerAddress,
        token_type: token.tokenType,
        currency_code: token.currencyCode,
        mpt_issuance_id: token.mptIssuanceId,
        transfer_fee: token.transferFee,
        clawback: token.clawback,
        freeze_enabled: token.freezeEnabled,
        max_supply: token.maxSupply,
        status: token.status,
        tx_id: token.txId,
        created_at: token.createdAt,
      },
      202, // 202 Accepted — tx is queued, not yet validated on-ledger
    );
  } catch (err) {
    if (err instanceof TokenServiceError) {
      const r = tokenErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

tokens.post('/:id/transfer', zValidator('json', transferTokenSchema), async (c) => {
  const clientId = c.get('clientId');
  const tokenId = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await transferToken({
      clientId,
      tokenId,
      destination: body.destination,
      amount: body.amount,
      destinationTag: body.destination_tag,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof TokenServiceError) {
      const r = tokenErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

tokens.put('/:id/freeze', zValidator('json', freezeTokenSchema), async (c) => {
  const clientId = c.get('clientId');
  const tokenId = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await freezeToken({
      clientId,
      tokenId,
      holder: body.holder,
      unfreeze: body.unfreeze,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof TokenServiceError) {
      const r = tokenErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

tokens.put('/:id/clawback', zValidator('json', clawbackTokenSchema), async (c) => {
  const clientId = c.get('clientId');
  const tokenId = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const result = await clawbackToken({
      clientId,
      tokenId,
      holder: body.holder,
      amount: body.amount,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof TokenServiceError) {
      const r = tokenErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

export default tokens;
