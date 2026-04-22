// Payment service routes.
//
// POST   /v1/payments                   → send XRP / MPT / issued-currency payment
// GET    /v1/payments/:id               → payment status (polls the transactions row)
// POST   /v1/payments/escrows           → create escrow
// POST   /v1/payments/escrows/:id/finish → finish escrow
// POST   /v1/payments/escrows/:id/cancel → cancel escrow
// POST   /v1/payments/batch             → sequential fallback for XLS-56 (pre-amendment)
//
// All payments are idempotent — middleware enforces the Idempotency-Key header.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  PaymentServiceError,
  cancelEscrow,
  createEscrow,
  finishEscrow,
  getPayment,
  sendBatchPayments,
  sendPayment,
} from '../services/payment.service.ts';
import type { AppEnv } from '../types.ts';
import {
  batchPaymentsSchema,
  cancelEscrowSchema,
  createEscrowSchema,
  finishEscrowSchema,
  sendPaymentSchema,
} from '../validators/schemas.ts';

const payments = new Hono<AppEnv>();

// REVIEW.md LOW-03: revocationCheck is mounted globally on /v1 — no
// per-router duplicate.

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
      idempotencyKey: c.req.header('idempotency-key'),
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
      idempotencyKey: c.req.header('idempotency-key'),
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
      idempotencyKey: c.req.header('idempotency-key'),
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
      idempotencyKey: c.req.header('idempotency-key'),
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

// Batch payments — pre-XLS-56 sequential fallback. Supports UNTIL_FAILURE
// (default) and INDEPENDENT. ALL_OR_NOTHING and ONLY_ONE are explicitly
// rejected at the schema layer; the service only accepts the two modes
// that can be faithfully emulated without atomic on-chain batching.
payments.post('/batch', zValidator('json', batchPaymentsSchema), async (c) => {
  const clientId = c.get('clientId');
  const body = c.req.valid('json');

  const result = await sendBatchPayments({
    clientId,
    mode: body.mode,
    idempotencyKey: c.req.header('idempotency-key'),
    payments: body.payments.map((p) => ({
      source: p.source,
      destination: p.destination,
      destinationTag: p.destination_tag,
      memo: p.memo,
      amountDrops: p.amount_drops,
      mptIssuanceId: p.mpt_issuance_id,
      value: p.value,
      currency: p.currency,
      issuer: p.issuer,
    })),
  });

  // 207 Multi-Status when any item errored; otherwise 202 Accepted.
  const anyError = result.results.some((r) => r.status === 'error');
  const status = anyError ? 207 : 202;
  return c.json(
    {
      mode: result.mode,
      results: result.results.map((r) => ({
        index: r.index,
        tx_id: r.txId,
        status: r.status,
        error_code: r.errorCode,
        error_message: r.errorMessage,
      })),
    },
    status,
  );
});

export default payments;
