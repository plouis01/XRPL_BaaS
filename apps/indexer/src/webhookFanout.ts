// Indexer-side webhook fan-out.
//
// When the indexer observes a validated on-chain tx involving a managed
// account that RailForge DIDN'T submit, fire the matching webhook event(s)
// to the owning client. This is the mechanism that surfaces EXTERNAL
// activity — a third-party KYC issuer creating a credential for one of
// our accounts, an outside party paying one of our accounts, etc.
//
// Interaction with txConfirmer:
//   - `transaction.validated` / `transaction.failed` — txConfirmer fires
//     these for INTERNAL txs (ones our worker submitted). To avoid double-
//     firing, this path skips internal txs FOR THOSE TWO EVENT TYPES ONLY
//     by looking up `transactions.tx_hash`.
//   - `credential.*` / `domain.*` — txConfirmer does NOT fire these
//     (verified: its `fanOutWebhooks` helper is hard-typed to the two
//     transaction.* strings). So the indexer is the single source for
//     these event types and must fire for BOTH internal and external
//     observations; otherwise clients issuing credentials through our
//     API would never receive `credential.issued`.
//   - `credential.expiring` — fired only by the credentialExpiry sweep
//     job, not here. No overlap.
//
// Event kind → webhook event type mapping (only kinds we fan out):
//
//   payment (success=true, destination is managed)
//     → 'transaction.validated' (headline "incoming payment" UX)
//   credential_create (subject is managed)
//     → 'credential.issued'
//   credential_accept (issuer is managed)
//     → 'credential.accepted'
//   credential_delete (subject is managed)
//     → 'credential.revoked'
//   domain_set (owner is managed)
//     → 'domain.updated'
//   domain_delete (owner is managed)
//     → 'domain.deleted'
//
// offer_create/cancel are not fanned out — no matching webhook event type
// exists in WEBHOOK_EVENT_TYPES. OfferCreate/Cancel txs from managed
// accounts already get `transaction.validated` via txConfirmer.

import { db as dbDefault, eq, inArray, schema } from '@railforge/db';
import { TX_CONFIRMER_EVENT_TYPES, enqueueWebhookDelivery } from '@railforge/jobs';
import { logger } from './logger.ts';
import type { TxEvent } from './parser.ts';

const log = logger.child({ component: 'webhook-fanout' });

let db: typeof dbDefault = dbDefault;

/** Test seam: inject a fake db client. */
export function __setDbForWebhookTests(fake: typeof dbDefault): void {
  db = fake;
}

/** Map TxEvent → (webhook event type, relevant addresses). */
function mapEvent(event: TxEvent): {
  eventType: string;
  addresses: string[];
  detail: Record<string, unknown>;
} | null {
  switch (event.kind) {
    case 'payment':
      if (!event.success) return null;
      return {
        eventType: 'transaction.validated',
        addresses: [event.destination],
        detail: {
          source: event.account,
          destination: event.destination,
          amount: event.amount,
        },
      };
    case 'credential_create':
      return {
        eventType: 'credential.issued',
        addresses: [event.subject],
        detail: {
          issuer: event.issuer,
          subject: event.subject,
          credential_type: event.credentialType,
          expiration: event.expiration,
        },
      };
    case 'credential_accept':
      return {
        eventType: 'credential.accepted',
        addresses: [event.issuer],
        detail: {
          issuer: event.issuer,
          subject: event.account,
          credential_type: event.credentialType,
        },
      };
    case 'credential_delete':
      // The CredentialDelete fields can carry either `subject` or `issuer`
      // depending on who initiated. Notify the credential holder.
      return {
        eventType: 'credential.revoked',
        addresses: event.subject ? [event.subject] : [event.account],
        detail: {
          account: event.account,
          subject: event.subject,
          issuer: event.issuer,
          credential_type: event.credentialType,
        },
      };
    case 'domain_set':
      return {
        eventType: 'domain.updated',
        addresses: [event.account],
        detail: {
          account: event.account,
          domain_id: event.domainId,
          accepted_credentials: event.acceptedCredentials,
        },
      };
    case 'domain_delete':
      return {
        eventType: 'domain.deleted',
        addresses: [event.account],
        detail: {
          account: event.account,
          domain_id: event.domainId,
        },
      };
    default:
      return null;
  }
}

/**
 * Fan out an external TxEvent as webhook deliveries. Returns the number
 * of deliveries enqueued (0 when no managed account is involved or the
 * tx is one of ours).
 */
// Event types that txConfirmer ALSO fires for internal txs. For these,
// the indexer must skip internal txs to avoid double-firing. All other
// event types (credential.*, domain.*) are indexer-only and fire for
// both internal and external observations.
//
// REVIEW.md MED-14: the literal set here used to be hardcoded; it's now
// derived from the shared TX_CONFIRMER_EVENT_TYPES const in @railforge/jobs,
// so extending txConfirmer's event union automatically extends the skip
// gate too. See the const's docblock for the rationale.
const TX_CONFIRMER_HANDLED = new Set<string>(TX_CONFIRMER_EVENT_TYPES);

export async function fanOutExternalTxEvent(event: TxEvent): Promise<number> {
  const mapped = mapEvent(event);
  if (!mapped) return 0;

  // Only skip internal txs for event types that txConfirmer also fires.
  // For credential.*/domain.*, the indexer is the single source — if we
  // skipped internal txs here, clients would never receive `credential.issued`
  // for credentials they created through our own API.
  if (TX_CONFIRMER_HANDLED.has(mapped.eventType)) {
    const ownRows = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(eq(schema.transactions.txHash, event.txHash))
      .limit(1);
    if (ownRows.length > 0) {
      log.debug(
        { txHash: event.txHash, eventType: mapped.eventType },
        'tx was internal — txConfirmer will fire this event',
      );
      return 0;
    }
  }

  // Find managed accounts whose address matches any of the event's
  // relevant addresses.
  const accountRows = await db
    .select({
      clientId: schema.accounts.clientId,
      address: schema.accounts.address,
    })
    .from(schema.accounts)
    .where(inArray(schema.accounts.address, mapped.addresses));
  if (accountRows.length === 0) return 0;

  // Dedupe by clientId — if one client has multiple managed accounts
  // involved (e.g., payment between two of their own addresses), fire
  // one webhook per subscription, not one per address.
  const clientIds = Array.from(new Set(accountRows.map((r) => r.clientId)));

  // Find active webhook endpoints subscribed to this event type for any
  // of those clients. Drizzle's array-contains needs a raw SQL operator
  // (`@>`), but we can just over-fetch active endpoints and filter in JS
  // — the endpoint count per client is tiny (single digits).
  const endpoints = await db
    .select({
      id: schema.webhookEndpoints.id,
      clientId: schema.webhookEndpoints.clientId,
      events: schema.webhookEndpoints.events,
    })
    .from(schema.webhookEndpoints)
    .where(inArray(schema.webhookEndpoints.clientId, clientIds));

  const matching = endpoints.filter(
    (ep) => Array.isArray(ep.events) && ep.events.includes(mapped.eventType),
  );
  if (matching.length === 0) return 0;

  const payload = {
    event: mapped.eventType,
    tx_hash: event.txHash,
    ledger_index: event.ledgerIndex,
    details: mapped.detail,
    source: 'indexer' as const,
  };

  let enqueued = 0;
  for (const ep of matching) {
    try {
      const inserted = await db
        .insert(schema.webhookDeliveries)
        .values({
          endpointId: ep.id,
          eventType: mapped.eventType,
          payload,
          status: 'pending',
          attempts: 0,
        })
        .returning({ id: schema.webhookDeliveries.id });
      const deliveryId = inserted[0]?.id;
      if (!deliveryId) continue;
      await enqueueWebhookDelivery({ deliveryId, endpointId: ep.id });
      enqueued += 1;
    } catch (err) {
      log.error(
        {
          err,
          endpointId: ep.id,
          eventType: mapped.eventType,
          txHash: event.txHash,
        },
        'webhook fanout enqueue failed (non-fatal)',
      );
    }
  }
  if (enqueued > 0) {
    log.info(
      { eventType: mapped.eventType, txHash: event.txHash, enqueued },
      'external webhook fan-out',
    );
  }
  return enqueued;
}
