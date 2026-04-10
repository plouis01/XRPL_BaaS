// Payment service routes.
//
// POST   /v1/payments                   → send XRP / MPT / issued-currency payment
// GET    /v1/payments/:id               → payment status (polls the transactions row)
// POST   /v1/payments/escrows           → create escrow
// POST   /v1/payments/escrows/:id/finish → finish escrow
// POST   /v1/payments/escrows/:id/cancel → cancel escrow
// POST   /v1/payments/batch             → TODO (XLS-56 V1.1 pending)
//
// All payments are idempotent — middleware enforces the Idempotency-Key header.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { revocationCheck } from '../middleware/revocationCheck.ts';
import {
  PaymentServiceError,
  cancelEscrow,
  createEscrow,
  finishEscrow,
  getPayment,
  sendPayment,
} from '../services/payment.service.ts';
import type { AppEnv } from '../types.ts';
import {
  cancelEscrowSchema,
  createEscrowSchema,
  finishEscrowSchema,
  sendPaymentSchema,
} from '../validators/schemas.ts';

const payments = new Hono<AppEnv>();

// Re-verify API key not revoked before enqueuing real transactions.
payments.use('*', revocationCheck);

function paymentErrorResponse(err: PaymentServiceError) {
  switch (err.code) {
    case 'source_not_found':
      return { error: 'Source account not found', status: 404 } as const;
    case 'source_not_funded':
      return { error: err.message, status: 409 } as const;
    case 'invalid_input':
      return { error: err.message, status: 400 } as const;
  }
}

payments.post('/', zValidator('json', sendPaymentSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await sendPayment({
      clientId,
      source: body.source,
      destination: body.destination,
      destinationTag: body.destination_tag,
      memo: body.memo,
      amountDrops: body.amount_drops,
      mptIssuanceId: body.mpt_issuance_id,
      value: body.value,
      currency: body.currency,
      issuer: body.issuer,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      const r = paymentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

payments.get('/:id', async (c) => {
  const clientId = c.get('clientId');
  const id = c.req.param('id');
  const payment = await getPayment(clientId, id);
  if (!payment) {
    return c.json({ error: 'Payment not found' }, 404);
  }
  return c.json({
    id: payment.id,
    tx_type: payment.txType,
    source_address: payment.sourceAddress,
    status: payment.status,
    result_code: payment.resultCode,
    tx_hash: payment.txHash,
    ledger_index: payment.ledgerIndex,
    fee_drops: payment.feeDrops,
    created_at: payment.createdAt,
    submitted_at: payment.submittedAt,
    confirmed_at: payment.confirmedAt,
  });
});

payments.post('/escrows', zValidator('json', createEscrowSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await createEscrow({
      clientId,
      source: body.source,
      destination: body.destination,
      amountDrops: body.amount_drops,
      finishAfter: body.finish_after,
      cancelAfter: body.cancel_after,
      condition: body.condition,
      destinationTag: body.destination_tag,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      const r = paymentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

payments.post('/escrows/:id/finish', zValidator('json', finishEscrowSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await finishEscrow({
      clientId,
      source: body.source,
      owner: body.owner,
      offerSequence: body.offer_sequence,
      condition: body.condition,
      fulfillment: body.fulfillment,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      const r = paymentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

payments.post('/escrows/:id/cancel', zValidator('json', cancelEscrowSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');
  try {
    const result = await cancelEscrow({
      clientId,
      source: body.source,
      owner: body.owner,
      offerSequence: body.offer_sequence,
    });
    return c.json({ tx_id: result.txId, status: 'queued' }, 202);
  } catch (err) {
    if (err instanceof PaymentServiceError) {
      const r = paymentErrorResponse(err);
      return c.json({ error: r.error }, r.status);
    }
    throw err;
  }
});

// Batch payments (XLS-56 V1.1 pending — see ARCHITECTURE.md §6).
payments.post('/batch', (c) => c.json({ error: 'not implemented' }, 501));

export default payments;
