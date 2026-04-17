// Indexer-side webhook fan-out.
//
// When the indexer observes a validated on-chain tx involving a managed
// account that RailForge DIDN'T submit, fire the matching webhook event(s)
// to the owning client. This is the mechanism that surfaces EXTERNAL
// activity — a third-party KYC issuer creating a credential for one of
// our accounts, an outside party paying one of our accounts, etc.
//
// txConfirmer already fires `transaction.validated` / `transaction.failed`
// for txs that our own worker submitted (it knows the tx id). To avoid
// double-firing, this path skips any tx whose hash is present in
// `transactions.tx_hash` — that's the hash our submitter recorded.
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
import { enqueueWebhookDelivery } from '@railforge/jobs';
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
export async function fanOutExternalTxEvent(event: TxEvent): Promise<number> {
  const mapped = mapEvent(event);
  if (!mapped) return 0;

  // Skip if this tx was submitted by our own system — txConfirmer already
  // fires the equivalent webhook via its own fan-out path, and double-
  // firing would confuse clients.
  const ownRows = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(eq(schema.transactions.txHash, event.txHash))
    .limit(1);
  if (ownRows.length > 0) {
    log.debug({ txHash: event.txHash }, 'tx was internal — skip external fan-out');
    return 0;
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
