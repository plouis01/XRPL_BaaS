// Unit tests for parseTransaction — the per-tx dispatcher. Pure logic,
// no XRPL client needed. Each case feeds a synthetic `ledger expand`
// payload and asserts the normalized TxEvent shape.

import { describe, expect, it } from 'vitest';
import { parseTransaction } from './parser.ts';

const SUCCESS = { TransactionResult: 'tesSUCCESS' };
const FAILURE = { TransactionResult: 'tecNO_LINE' };

function payload(fields: Record<string, unknown>, meta = SUCCESS): unknown {
  return {
    hash: 'ABCDEF'.padEnd(64, '0'),
    ledger_index: 42,
    TransactionType: fields.TransactionType,
    ...fields,
    meta,
  };
}

describe('parseTransaction — rejection path', () => {
  it('returns null on null / non-object input', () => {
    expect(parseTransaction(null)).toBeNull();
    expect(parseTransaction('not an object')).toBeNull();
  });

  it('returns null when hash is missing', () => {
    expect(
      parseTransaction({
        ledger_index: 1,
        TransactionType: 'Payment',
        meta: SUCCESS,
      }),
    ).toBeNull();
  });

  it('returns null when ledger_index is missing', () => {
    expect(
      parseTransaction({
        hash: 'x'.repeat(64),
        TransactionType: 'Payment',
        meta: SUCCESS,
      }),
    ).toBeNull();
  });

  it('returns null when TransactionType is missing', () => {
    expect(
      parseTransaction({
        hash: 'x'.repeat(64),
        ledger_index: 1,
        meta: SUCCESS,
      }),
    ).toBeNull();
  });
});

describe('parseTransaction — Payment', () => {
  it('normalizes XRP payment', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'Payment',
        Account: 'rSender',
        Destination: 'rReceiver',
        Amount: '1000000',
      }),
    );
    expect(ev).toEqual(
      expect.objectContaining({
        kind: 'payment',
        account: 'rSender',
        destination: 'rReceiver',
        amount: '1000000',
        success: true,
        ledgerIndex: 42,
      }),
    );
  });

  it('normalizes IOU payment', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'Payment',
        Account: 'rSender',
        Destination: 'rReceiver',
        Amount: { currency: 'USD', issuer: 'rIssuer', value: '10' },
      }),
    );
    expect(ev?.kind).toBe('payment');
    if (ev?.kind === 'payment') {
      expect(ev.amount).toEqual({
        currency: 'USD',
        issuer: 'rIssuer',
        value: '10',
      });
    }
  });

  it('normalizes MPT payment', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'Payment',
        Account: 'rSender',
        Destination: 'rReceiver',
        Amount: { mpt_issuance_id: 'DEADBEEF', value: '5' },
      }),
    );
    expect(ev?.kind).toBe('payment');
  });

  it('carries success=false when meta indicates failure', () => {
    const ev = parseTransaction(
      payload(
        {
          TransactionType: 'Payment',
          Account: 'rA',
          Destination: 'rB',
          Amount: '1',
        },
        FAILURE,
      ),
    );
    expect(ev?.success).toBe(false);
  });

  it("falls back to 'other' when required fields missing", () => {
    const ev = parseTransaction(payload({ TransactionType: 'Payment', Account: 'rA' }));
    expect(ev?.kind).toBe('other');
  });
});

describe('parseTransaction — CredentialCreate / Accept / Delete', () => {
  it('normalizes CredentialCreate', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'CredentialCreate',
        Account: 'rIssuer',
        Subject: 'rSubject',
        CredentialType: '4B5943',
        Expiration: 100,
      }),
    );
    expect(ev).toEqual(
      expect.objectContaining({
        kind: 'credential_create',
        issuer: 'rIssuer',
        subject: 'rSubject',
        credentialType: '4B5943',
        expiration: 100,
      }),
    );
  });

  it('normalizes CredentialAccept', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'CredentialAccept',
        Account: 'rSubject',
        Issuer: 'rIssuer',
        CredentialType: '4B5943',
      }),
    );
    expect(ev?.kind).toBe('credential_accept');
  });

  it('normalizes CredentialDelete with subject field', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'CredentialDelete',
        Account: 'rIssuer',
        Subject: 'rSubject',
        CredentialType: '4B5943',
      }),
    );
    expect(ev?.kind).toBe('credential_delete');
    if (ev?.kind === 'credential_delete') {
      expect(ev.subject).toBe('rSubject');
    }
  });
});

describe('parseTransaction — OfferCreate / OfferCancel', () => {
  it('normalizes OfferCreate with domain', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'OfferCreate',
        Account: 'rMaker',
        Sequence: 7,
        TakerGets: '1000000',
        TakerPays: { currency: 'USD', issuer: 'rIssuer', value: '10' },
        DomainID: 'DEADBEEF',
      }),
    );
    expect(ev).toEqual(
      expect.objectContaining({
        kind: 'offer_create',
        account: 'rMaker',
        sequence: 7,
        domainId: 'DEADBEEF',
      }),
    );
  });

  it('normalizes OfferCancel', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'OfferCancel',
        Account: 'rMaker',
        OfferSequence: 7,
      }),
    );
    expect(ev).toEqual(
      expect.objectContaining({
        kind: 'offer_cancel',
        account: 'rMaker',
        offerSequence: 7,
      }),
    );
  });
});

describe('parseTransaction — Permissioned domains', () => {
  it('normalizes PermissionedDomainSet with accepted credentials array', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'PermissionedDomainSet',
        Account: 'rOwner',
        DomainID: 'ABC',
        AcceptedCredentials: [
          { Credential: { Issuer: 'rIssuer1', CredentialType: '4B5943' } },
          { Credential: { Issuer: 'rIssuer2', CredentialType: '4B4D4C' } },
        ],
      }),
    );
    expect(ev?.kind).toBe('domain_set');
    if (ev?.kind === 'domain_set') {
      expect(ev.acceptedCredentials).toHaveLength(2);
      expect(ev.acceptedCredentials?.[0]).toEqual({
        issuer: 'rIssuer1',
        credentialType: '4B5943',
      });
    }
  });

  it('normalizes PermissionedDomainDelete', () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'PermissionedDomainDelete',
        Account: 'rOwner',
        DomainID: 'ABC',
      }),
    );
    expect(ev).toEqual(expect.objectContaining({ kind: 'domain_delete', domainId: 'ABC' }));
  });
});

describe('parseTransaction — fallback', () => {
  it("returns 'other' for unknown TransactionType", () => {
    const ev = parseTransaction(
      payload({
        TransactionType: 'DIDSet',
        Account: 'rA',
      }),
    );
    expect(ev?.kind).toBe('other');
    if (ev?.kind === 'other') expect(ev.txType).toBe('DIDSet');
  });

  it('reads metaData (not meta) for ledger-expand payloads using that field', () => {
    const ev = parseTransaction({
      hash: 'y'.repeat(64),
      ledger_index: 1,
      TransactionType: 'Payment',
      Account: 'rA',
      Destination: 'rB',
      Amount: '1',
      metaData: SUCCESS,
    });
    expect(ev?.success).toBe(true);
  });

  it('reads tx.TransactionType when fields nested under `tx`', () => {
    const ev = parseTransaction({
      hash: 'z'.repeat(64),
      ledger_index: 1,
      meta: SUCCESS,
      tx: {
        TransactionType: 'Payment',
        Account: 'rA',
        Destination: 'rB',
        Amount: '1',
      },
    });
    expect(ev?.kind).toBe('payment');
  });
});
