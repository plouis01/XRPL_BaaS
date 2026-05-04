// Tests for canonical xrpl-core transaction builders.
//
// Strategy: each builder is tested for (1) correct shape of the returned
// object, (2) optional fields only present when supplied, (3) validation
// errors on out-of-range inputs, and (4) round-trip through xrpl.js
// encode/decode — the strongest proof that the shape is well-formed.

import { describe, expect, it } from 'vitest';
import { Wallet, decode, encode } from 'xrpl';
import type { Transaction } from 'xrpl';
import {
  MPT_LOCK_FLAG,
  MPT_UNLOCK_FLAG,
  assetAmountToXrpl,
  assetToCurrency,
  buildAccountDelete,
  buildAccountSet,
  buildAmmDeposit,
  buildAmmWithdraw,
  buildCredentialAccept,
  buildCredentialCreate,
  buildCredentialDelete,
  buildEscrowCancel,
  buildEscrowCreate,
  buildEscrowFinish,
  buildIssuedCurrencyClawback,
  buildIssuedCurrencyPayment,
  buildMptClawback,
  buildMptIssuanceCreate,
  buildMptIssuanceSet,
  buildMptPayment,
  buildOfferCancel,
  buildOfferCreate,
  buildPermissionedDomainDelete,
  buildPermissionedDomainSet,
  buildSetRegularKey,
  buildSignerListSet,
  buildTrustSet,
  buildXrpPayment,
} from './transactions.ts';

// Reasonably-formatted hex MPT issuance id (24 bytes = 48 hex chars).
const MPT_ID = '00000ABC1234567890ABCDEF1234567890ABCDEF12345678';

// Real r-addresses for test fixtures. xrpl.js validates these on encode,
// so we can't use placeholder strings.
const WALLET_A = Wallet.generate();
const WALLET_B = Wallet.generate();
const WALLET_C = Wallet.generate();
const ACCOUNT_A = WALLET_A.classicAddress;
const ACCOUNT_B = WALLET_B.classicAddress;
const ACCOUNT_C = WALLET_C.classicAddress;

/**
 * Round-trip a tx through xrpl.js encode/decode. Proves:
 * (a) the shape is well-formed enough to serialize, and
 * (b) all fields survive the round-trip (no silent drops).
 *
 * We have to fill in the pipeline-supplied fields (Sequence, Fee,
 * LastLedgerSequence) to make encode happy — the builders deliberately
 * leave these blank. SigningPubKey gets a dummy hex string.
 */
function roundTrip<T extends Transaction>(tx: T): T {
  // The cast to Transaction (via unknown) is needed because xrpl's `encode`
  // typing expects a fully-resolved discriminated union member, but we want
  // this helper to be generic over any builder output.
  const filled = {
    ...tx,
    Sequence: 1,
    Fee: '12',
    LastLedgerSequence: 100,
    SigningPubKey: '',
  } as unknown as Transaction;
  const hex = encode(filled);
  return decode(hex) as unknown as T;
}

describe('buildXrpPayment', () => {
  it('produces a minimal XRP Payment', () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '1000000',
    });
    expect(tx.TransactionType).toBe('Payment');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Destination).toBe(ACCOUNT_B);
    expect(tx.Amount).toBe('1000000');
    expect(tx.DestinationTag).toBeUndefined();
    expect(tx.Memos).toBeUndefined();
  });

  it('includes DestinationTag when provided', () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '100',
      destinationTag: 12345,
    });
    expect(tx.DestinationTag).toBe(12345);
  });

  it('encodes a memo as hex-uppercase UTF-8', () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '100',
      memo: 'hello',
    });
    const memoData = tx.Memos?.[0]?.Memo?.MemoData;
    expect(memoData).toBe('68656C6C6F'); // "hello" hex
  });

  it('round-trips through encode/decode', () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '1000000',
      destinationTag: 1,
    });
    const rt = roundTrip(tx);
    expect(rt.Account).toBe(ACCOUNT_A);
    expect(rt.Destination).toBe(ACCOUNT_B);
    expect(rt.Amount).toBe('1000000');
    expect(rt.DestinationTag).toBe(1);
  });
});

describe('buildIssuedCurrencyPayment', () => {
  it('produces an issued-currency Payment with nested Amount', () => {
    const tx = buildIssuedCurrencyPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      currency: 'USD',
      issuer: ACCOUNT_C,
      value: '100',
    });
    expect(tx.Amount).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_C,
      value: '100',
    });
  });

  it('round-trips through encode/decode', () => {
    const tx = buildIssuedCurrencyPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      currency: 'USD',
      issuer: ACCOUNT_C,
      value: '100',
    });
    const rt = roundTrip(tx);
    expect(rt.Amount).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_C,
      value: '100',
    });
  });
});

describe('buildAccountSet', () => {
  it('produces a minimal AccountSet', () => {
    const tx = buildAccountSet({ account: ACCOUNT_A });
    expect(tx.TransactionType).toBe('AccountSet');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.SetFlag).toBeUndefined();
    expect(tx.Domain).toBeUndefined();
  });

  it('includes SetFlag and ClearFlag when provided', () => {
    const tx = buildAccountSet({
      account: ACCOUNT_A,
      setFlag: 2,
      clearFlag: 3,
    });
    expect(tx.SetFlag).toBe(2);
    expect(tx.ClearFlag).toBe(3);
  });

  it('uppercases the domain hex', () => {
    const tx = buildAccountSet({ account: ACCOUNT_A, domain: 'deadbeef' });
    expect(tx.Domain).toBe('DEADBEEF');
  });

  it('round-trips through encode/decode', () => {
    const tx = buildAccountSet({ account: ACCOUNT_A, setFlag: 1 });
    const rt = roundTrip(tx);
    expect(rt.Account).toBe(ACCOUNT_A);
    expect(rt.SetFlag).toBe(1);
  });
});

describe('buildSignerListSet', () => {
  it('produces a SignerListSet with nested SignerEntries', () => {
    const tx = buildSignerListSet({
      account: ACCOUNT_A,
      signerQuorum: 2,
      signerEntries: [
        { address: ACCOUNT_B, weight: 1 },
        { address: ACCOUNT_C, weight: 1 },
      ],
    });
    expect(tx.SignerQuorum).toBe(2);
    expect(tx.SignerEntries).toHaveLength(2);
    expect(tx.SignerEntries?.[0]).toEqual({
      SignerEntry: { Account: ACCOUNT_B, SignerWeight: 1 },
    });
  });

  it('throws on more than 32 entries', () => {
    const entries = Array.from({ length: 33 }, () => ({
      address: ACCOUNT_B,
      weight: 1,
    }));
    expect(() =>
      buildSignerListSet({
        account: ACCOUNT_A,
        signerQuorum: 1,
        signerEntries: entries,
      }),
    ).toThrow(/at most 32/);
  });

  it('throws on negative quorum', () => {
    expect(() =>
      buildSignerListSet({
        account: ACCOUNT_A,
        signerQuorum: -1,
        signerEntries: [{ address: ACCOUNT_B, weight: 1 }],
      }),
    ).toThrow(/>= 0/);
  });

  it('quorum=0 + empty entries OMITS SignerEntries entirely (signer list delete)', () => {
    // Per the XRPL spec, deleting a signer list requires SignerQuorum=0
    // AND no SignerEntries field. Sending SignerEntries: [] yields
    // temMALFORMED at rippled before the tx reaches a ledger — which
    // bit revokePermission for any agent that was the parent's last
    // remaining delegate. The fix omits the field; this test guards
    // against the regression by asserting the property is absent
    // (NOT empty array).
    const tx = buildSignerListSet({
      account: ACCOUNT_A,
      signerQuorum: 0,
      signerEntries: [],
    });
    expect(tx.SignerQuorum).toBe(0);
    expect(tx).not.toHaveProperty('SignerEntries');
    // Encode round-trip confirms the wire format also omits it.
    const rt = roundTrip(tx);
    expect(rt).not.toHaveProperty('SignerEntries');
  });
});

describe('buildAccountDelete', () => {
  it('produces an AccountDelete', () => {
    const tx = buildAccountDelete({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
    });
    expect(tx.TransactionType).toBe('AccountDelete');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Destination).toBe(ACCOUNT_B);
  });

  it('round-trips through encode/decode', () => {
    const tx = buildAccountDelete({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      destinationTag: 42,
    });
    const rt = roundTrip(tx);
    expect(rt.Destination).toBe(ACCOUNT_B);
    expect(rt.DestinationTag).toBe(42);
  });
});

describe('buildMptIssuanceCreate', () => {
  it('produces a minimal MPTokenIssuanceCreate', () => {
    const tx = buildMptIssuanceCreate({ account: ACCOUNT_A });
    expect(tx.TransactionType).toBe('MPTokenIssuanceCreate');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.AssetScale).toBeUndefined();
    expect(tx.TransferFee).toBeUndefined();
  });

  it('includes optional fields when provided', () => {
    const tx = buildMptIssuanceCreate({
      account: ACCOUNT_A,
      assetScale: 6,
      transferFee: 500, // 0.5%
      maximumAmount: '1000000000',
      flags: 0x04, // tfMPTCanTransfer
      mptMetadata: 'deadbeef',
    });
    expect(tx.AssetScale).toBe(6);
    expect(tx.TransferFee).toBe(500);
    expect(tx.MaximumAmount).toBe('1000000000');
    expect(tx.Flags).toBe(0x04);
    expect(tx.MPTokenMetadata).toBe('DEADBEEF');
  });

  it('throws on transferFee > 50000', () => {
    expect(() => buildMptIssuanceCreate({ account: ACCOUNT_A, transferFee: 50_001 })).toThrow(
      /0-50000/,
    );
  });

  it('throws on negative transferFee', () => {
    expect(() => buildMptIssuanceCreate({ account: ACCOUNT_A, transferFee: -1 })).toThrow(
      /0-50000/,
    );
  });

  it('throws on assetScale out of range', () => {
    expect(() => buildMptIssuanceCreate({ account: ACCOUNT_A, assetScale: 20 })).toThrow(/0-19/);
  });
});

describe('buildTrustSet', () => {
  it('produces a TrustSet with nested LimitAmount', () => {
    const tx = buildTrustSet({
      account: ACCOUNT_A,
      currency: 'USD',
      issuer: ACCOUNT_B,
      limit: '1000000',
    });
    expect(tx.TransactionType).toBe('TrustSet');
    expect(tx.LimitAmount).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_B,
      value: '1000000',
    });
  });

  it('includes QualityIn/QualityOut when provided', () => {
    const tx = buildTrustSet({
      account: ACCOUNT_A,
      currency: 'USD',
      issuer: ACCOUNT_B,
      limit: '100',
      qualityIn: 1_000_000_000,
      qualityOut: 999_000_000,
    });
    expect(tx.QualityIn).toBe(1_000_000_000);
    expect(tx.QualityOut).toBe(999_000_000);
  });

  it('round-trips through encode/decode', () => {
    const tx = buildTrustSet({
      account: ACCOUNT_A,
      currency: 'USD',
      issuer: ACCOUNT_B,
      limit: '100',
    });
    const rt = roundTrip(tx);
    expect(rt.LimitAmount).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_B,
      value: '100',
    });
  });
});

describe('buildMptPayment', () => {
  it('produces a Payment with MPT amount shape', () => {
    const tx = buildMptPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      mptIssuanceId: MPT_ID,
      value: '100',
    });
    expect(tx.TransactionType).toBe('Payment');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Destination).toBe(ACCOUNT_B);
    expect(tx.Amount).toEqual({
      mpt_issuance_id: MPT_ID,
      value: '100',
    });
  });

  it('includes DestinationTag when provided', () => {
    const tx = buildMptPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      mptIssuanceId: MPT_ID,
      value: '1',
      destinationTag: 99,
    });
    expect(tx.DestinationTag).toBe(99);
  });
});

describe('buildMptIssuanceSet', () => {
  it('produces a lock tx with tfMPTLock flag', () => {
    const tx = buildMptIssuanceSet({
      account: ACCOUNT_A,
      mptIssuanceId: MPT_ID,
      action: 'lock',
    });
    expect(tx.TransactionType).toBe('MPTokenIssuanceSet');
    expect(tx.MPTokenIssuanceID).toBe(MPT_ID);
    expect(tx.Flags).toBe(MPT_LOCK_FLAG);
    expect(tx.Holder).toBeUndefined();
  });

  it('produces an unlock tx with tfMPTUnlock flag', () => {
    const tx = buildMptIssuanceSet({
      account: ACCOUNT_A,
      mptIssuanceId: MPT_ID,
      action: 'unlock',
    });
    expect(tx.Flags).toBe(MPT_UNLOCK_FLAG);
  });

  it('includes Holder when freezing a single holder (not the whole issuance)', () => {
    const tx = buildMptIssuanceSet({
      account: ACCOUNT_A,
      mptIssuanceId: MPT_ID,
      action: 'lock',
      holder: ACCOUNT_B,
    });
    expect(tx.Holder).toBe(ACCOUNT_B);
  });
});

describe('buildIssuedCurrencyClawback', () => {
  it('produces a Clawback with the holder address in Amount.issuer', () => {
    // Note the counter-intuitive shape: Amount.issuer is the HOLDER, not
    // the currency issuer. The XRPL Clawback spec defines it this way.
    const tx = buildIssuedCurrencyClawback({
      account: ACCOUNT_A, // issuer reclaiming
      currency: 'USD',
      holder: ACCOUNT_B, // holder being clawed back
      value: '10',
    });
    expect(tx.TransactionType).toBe('Clawback');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Amount).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_B,
      value: '10',
    });
  });
});

describe('buildMptClawback', () => {
  it('produces a Clawback with MPT amount + Holder field', () => {
    const tx = buildMptClawback({
      account: ACCOUNT_A,
      mptIssuanceId: MPT_ID,
      holder: ACCOUNT_B,
      value: '10',
    });
    expect(tx.TransactionType).toBe('Clawback');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Amount).toEqual({
      mpt_issuance_id: MPT_ID,
      value: '10',
    });
    expect(tx.Holder).toBe(ACCOUNT_B);
  });
});

describe('buildSetRegularKey', () => {
  it('sets a new regular key', () => {
    const tx = buildSetRegularKey({
      account: ACCOUNT_A,
      regularKey: ACCOUNT_B,
    });
    expect(tx.TransactionType).toBe('SetRegularKey');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.RegularKey).toBe(ACCOUNT_B);
  });

  it('clears the regular key when null is passed (omits RegularKey field)', () => {
    const tx = buildSetRegularKey({
      account: ACCOUNT_A,
      regularKey: null,
    });
    expect(tx.TransactionType).toBe('SetRegularKey');
    expect(tx.RegularKey).toBeUndefined();
  });

  it('round-trips through encode/decode (set)', () => {
    const tx = buildSetRegularKey({
      account: ACCOUNT_A,
      regularKey: ACCOUNT_B,
    });
    const rt = roundTrip(tx);
    expect(rt.RegularKey).toBe(ACCOUNT_B);
  });
});

describe('buildEscrowCreate', () => {
  it('produces an EscrowCreate with FinishAfter', () => {
    const tx = buildEscrowCreate({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '1000000',
      finishAfter: 800000000,
    });
    expect(tx.TransactionType).toBe('EscrowCreate');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Destination).toBe(ACCOUNT_B);
    expect(tx.Amount).toBe('1000000');
    expect(tx.FinishAfter).toBe(800000000);
    expect(tx.CancelAfter).toBeUndefined();
  });

  it('includes CancelAfter and Condition when provided', () => {
    const tx = buildEscrowCreate({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '100',
      finishAfter: 800000000,
      cancelAfter: 800100000,
      condition: 'A0258020',
    });
    expect(tx.CancelAfter).toBe(800100000);
    expect(tx.Condition).toBe('A0258020');
  });

  it('throws when neither finishAfter nor cancelAfter is set', () => {
    expect(() =>
      buildEscrowCreate({
        account: ACCOUNT_A,
        destination: ACCOUNT_B,
        amountDrops: '100',
      }),
    ).toThrow(/at least one/);
  });

  it('throws when cancelAfter <= finishAfter', () => {
    expect(() =>
      buildEscrowCreate({
        account: ACCOUNT_A,
        destination: ACCOUNT_B,
        amountDrops: '100',
        finishAfter: 800000000,
        cancelAfter: 800000000, // equal — invalid
      }),
    ).toThrow(/cancelAfter must be after/);
  });

  it('round-trips through encode/decode', () => {
    const tx = buildEscrowCreate({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: '1000000',
      finishAfter: 800000000,
      cancelAfter: 800100000,
    });
    const rt = roundTrip(tx);
    expect(rt.Amount).toBe('1000000');
    expect(rt.FinishAfter).toBe(800000000);
    expect(rt.CancelAfter).toBe(800100000);
  });
});

describe('buildEscrowFinish', () => {
  it('produces an EscrowFinish', () => {
    const tx = buildEscrowFinish({
      account: ACCOUNT_A,
      owner: ACCOUNT_B,
      offerSequence: 42,
    });
    expect(tx.TransactionType).toBe('EscrowFinish');
    expect(tx.Owner).toBe(ACCOUNT_B);
    expect(tx.OfferSequence).toBe(42);
  });

  it('includes Condition + Fulfillment when provided', () => {
    const tx = buildEscrowFinish({
      account: ACCOUNT_A,
      owner: ACCOUNT_B,
      offerSequence: 42,
      condition: 'A0258020',
      fulfillment: 'A0028000',
    });
    expect(tx.Condition).toBe('A0258020');
    expect(tx.Fulfillment).toBe('A0028000');
  });
});

describe('buildEscrowCancel', () => {
  it('produces an EscrowCancel', () => {
    const tx = buildEscrowCancel({
      account: ACCOUNT_A,
      owner: ACCOUNT_B,
      offerSequence: 42,
    });
    expect(tx.TransactionType).toBe('EscrowCancel');
    expect(tx.Owner).toBe(ACCOUNT_B);
    expect(tx.OfferSequence).toBe(42);
  });
});

// ── Credential builders (XLS-70) ──────────────────────────────────────────

describe('buildCredentialCreate', () => {
  it('produces a minimal CredentialCreate', () => {
    const tx = buildCredentialCreate({
      account: ACCOUNT_A,
      subject: ACCOUNT_B,
      credentialType: '4B5943',
    });
    expect(tx.TransactionType).toBe('CredentialCreate');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Subject).toBe(ACCOUNT_B);
    expect(tx.CredentialType).toBe('4B5943');
    expect(tx.Expiration).toBeUndefined();
    expect(tx.URI).toBeUndefined();
  });

  it('includes Expiration and URI when provided', () => {
    const tx = buildCredentialCreate({
      account: ACCOUNT_A,
      subject: ACCOUNT_B,
      credentialType: '4b5943',
      expiration: 800000000,
      uri: '68747470733a2f2f',
    });
    expect(tx.Expiration).toBe(800000000);
    expect(tx.URI).toBe('68747470733A2F2F');
    expect(tx.CredentialType).toBe('4B5943');
  });

  it('throws on empty credential type', () => {
    expect(() =>
      buildCredentialCreate({
        account: ACCOUNT_A,
        subject: ACCOUNT_B,
        credentialType: '',
      }),
    ).toThrow(/1-128 hex chars/);
  });

  it('throws on oversized credential type (>128 hex chars)', () => {
    expect(() =>
      buildCredentialCreate({
        account: ACCOUNT_A,
        subject: ACCOUNT_B,
        credentialType: 'AB'.repeat(65),
      }),
    ).toThrow(/1-128 hex chars/);
  });
});

describe('buildCredentialAccept', () => {
  it('produces a CredentialAccept', () => {
    const tx = buildCredentialAccept({
      account: ACCOUNT_B,
      issuer: ACCOUNT_A,
      credentialType: '4b5943',
    });
    expect(tx.TransactionType).toBe('CredentialAccept');
    expect(tx.Account).toBe(ACCOUNT_B);
    expect(tx.Issuer).toBe(ACCOUNT_A);
    expect(tx.CredentialType).toBe('4B5943');
  });
});

describe('buildCredentialDelete', () => {
  it('produces a CredentialDelete with subject (issuer-initiated)', () => {
    const tx = buildCredentialDelete({
      account: ACCOUNT_A,
      credentialType: '4B5943',
      subject: ACCOUNT_B,
    });
    expect(tx.TransactionType).toBe('CredentialDelete');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Subject).toBe(ACCOUNT_B);
    expect(tx.Issuer).toBeUndefined();
  });

  it('produces a CredentialDelete with issuer (subject-initiated)', () => {
    const tx = buildCredentialDelete({
      account: ACCOUNT_B,
      credentialType: '4B5943',
      issuer: ACCOUNT_A,
    });
    expect(tx.Issuer).toBe(ACCOUNT_A);
    expect(tx.Subject).toBeUndefined();
  });

  it('throws when neither subject nor issuer is provided', () => {
    expect(() => buildCredentialDelete({ account: ACCOUNT_A, credentialType: '4B5943' })).toThrow(
      /requires either subject or issuer/,
    );
  });
});

// ── Permissioned Domain builders (XLS-80) ──────────────────────────────────

describe('buildPermissionedDomainSet', () => {
  it('produces a create (no DomainID)', () => {
    const tx = buildPermissionedDomainSet({
      account: ACCOUNT_A,
      acceptedCredentials: [{ issuer: ACCOUNT_B, credentialType: '4B5943' }],
    });
    expect(tx.TransactionType).toBe('PermissionedDomainSet');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.DomainID).toBeUndefined();
    expect(tx.AcceptedCredentials).toHaveLength(1);
    expect(tx.AcceptedCredentials[0]!.Credential.Issuer).toBe(ACCOUNT_B);
    expect(tx.AcceptedCredentials[0]!.Credential.CredentialType).toBe('4B5943');
  });

  it('produces an update (with DomainID)', () => {
    const tx = buildPermissionedDomainSet({
      account: ACCOUNT_A,
      domainId: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
      acceptedCredentials: [
        { issuer: ACCOUNT_B, credentialType: '4B5943' },
        { issuer: ACCOUNT_C, credentialType: '414D4C' },
      ],
    });
    expect(tx.DomainID).toBe('ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890');
    expect(tx.AcceptedCredentials).toHaveLength(2);
  });

  it('throws on empty accepted credentials', () => {
    expect(() =>
      buildPermissionedDomainSet({
        account: ACCOUNT_A,
        acceptedCredentials: [],
      }),
    ).toThrow(/1-10 entries/);
  });

  it('throws on >10 accepted credentials', () => {
    const entries = Array.from({ length: 11 }, (_, i) => ({
      issuer: ACCOUNT_B,
      credentialType: `4B594${i.toString(16).toUpperCase()}`,
    }));
    expect(() =>
      buildPermissionedDomainSet({
        account: ACCOUNT_A,
        acceptedCredentials: entries,
      }),
    ).toThrow(/1-10 entries/);
  });
});

describe('buildPermissionedDomainDelete', () => {
  it('produces a PermissionedDomainDelete', () => {
    const tx = buildPermissionedDomainDelete({
      account: ACCOUNT_A,
      domainId: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
    });
    expect(tx.TransactionType).toBe('PermissionedDomainDelete');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.DomainID).toBe('ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890');
  });
});

// ── DEX builders ────────────────────────────────────────────────────────────

describe('assetAmountToXrpl', () => {
  it('converts XRP drops', () => {
    expect(assetAmountToXrpl({ drops: '1000000' })).toBe('1000000');
  });

  it('converts issued currency', () => {
    expect(assetAmountToXrpl({ currency: 'USD', issuer: ACCOUNT_A, value: '10' })).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_A,
      value: '10',
    });
  });

  it('converts MPT amount', () => {
    expect(assetAmountToXrpl({ mptIssuanceId: MPT_ID, value: '50' })).toEqual({
      mpt_issuance_id: MPT_ID,
      value: '50',
    });
  });

  it('throws on invalid input', () => {
    expect(() => assetAmountToXrpl({ value: '10' })).toThrow();
  });
});

describe('assetToCurrency', () => {
  it('converts XRP to Currency', () => {
    expect(assetToCurrency({ drops: '0' })).toEqual({ currency: 'XRP' });
  });

  it('converts issued currency to Currency', () => {
    expect(assetToCurrency({ currency: 'USD', issuer: ACCOUNT_A })).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_A,
    });
  });

  it('converts MPT to Currency', () => {
    expect(assetToCurrency({ mptIssuanceId: MPT_ID })).toEqual({
      mpt_issuance_id: MPT_ID,
    });
  });
});

describe('buildOfferCreate', () => {
  it('produces a minimal OfferCreate (XRP for issued currency)', () => {
    const tx = buildOfferCreate({
      account: ACCOUNT_A,
      takerGets: { drops: '1000000' },
      takerPays: { currency: 'USD', issuer: ACCOUNT_B, value: '10' },
    });
    expect(tx.TransactionType).toBe('OfferCreate');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.TakerGets).toBe('1000000');
    expect(tx.TakerPays).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_B,
      value: '10',
    });
    expect(tx.Expiration).toBeUndefined();
    expect(tx.OfferSequence).toBeUndefined();
    expect(tx.DomainID).toBeUndefined();
  });

  it('includes optional fields when provided', () => {
    const tx = buildOfferCreate({
      account: ACCOUNT_A,
      takerGets: { drops: '1000000' },
      takerPays: { currency: 'USD', issuer: ACCOUNT_B, value: '10' },
      expiration: 800000000,
      offerSequence: 42,
      flags: 65536,
      domainId: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
    });
    expect(tx.Expiration).toBe(800000000);
    expect(tx.OfferSequence).toBe(42);
    expect(tx.Flags).toBe(65536);
    expect(tx.DomainID).toBe('ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890');
  });
});

describe('buildOfferCancel', () => {
  it('produces an OfferCancel', () => {
    const tx = buildOfferCancel({
      account: ACCOUNT_A,
      offerSequence: 42,
    });
    expect(tx.TransactionType).toBe('OfferCancel');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.OfferSequence).toBe(42);
  });
});

describe('buildAmmDeposit', () => {
  it('produces a minimal AMMDeposit', () => {
    const tx = buildAmmDeposit({
      account: ACCOUNT_A,
      asset: { drops: '0' },
      asset2: { currency: 'USD', issuer: ACCOUNT_B },
    });
    expect(tx.TransactionType).toBe('AMMDeposit');
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Asset).toEqual({ currency: 'XRP' });
    expect(tx.Asset2).toEqual({ currency: 'USD', issuer: ACCOUNT_B });
    expect(tx.Amount).toBeUndefined();
    expect(tx.Amount2).toBeUndefined();
  });

  it('includes Amount and Amount2 when provided', () => {
    const tx = buildAmmDeposit({
      account: ACCOUNT_A,
      asset: { drops: '0' },
      asset2: { currency: 'USD', issuer: ACCOUNT_B },
      amount: { drops: '5000000' },
      amount2: { currency: 'USD', issuer: ACCOUNT_B, value: '5' },
      flags: 1048576,
    });
    expect(tx.Amount).toBe('5000000');
    expect(tx.Amount2).toEqual({
      currency: 'USD',
      issuer: ACCOUNT_B,
      value: '5',
    });
    expect(tx.Flags).toBe(1048576);
  });

  it('includes LPTokenOut when provided', () => {
    const tx = buildAmmDeposit({
      account: ACCOUNT_A,
      asset: { drops: '0' },
      asset2: { currency: 'USD', issuer: ACCOUNT_B },
      lpTokenOut: { currency: 'LP', issuer: ACCOUNT_C, value: '100' },
      flags: 65536,
    });
    expect(tx.LPTokenOut).toEqual({
      currency: 'LP',
      issuer: ACCOUNT_C,
      value: '100',
    });
  });
});

describe('buildAmmWithdraw', () => {
  it('produces a minimal AMMWithdraw', () => {
    const tx = buildAmmWithdraw({
      account: ACCOUNT_A,
      asset: { drops: '0' },
      asset2: { currency: 'USD', issuer: ACCOUNT_B },
    });
    expect(tx.TransactionType).toBe('AMMWithdraw');
    expect(tx.Asset).toEqual({ currency: 'XRP' });
    expect(tx.Asset2).toEqual({ currency: 'USD', issuer: ACCOUNT_B });
  });

  it('includes LPTokenIn and flags', () => {
    const tx = buildAmmWithdraw({
      account: ACCOUNT_A,
      asset: { drops: '0' },
      asset2: { currency: 'USD', issuer: ACCOUNT_B },
      lpTokenIn: { currency: 'LP', issuer: ACCOUNT_C, value: '50' },
      flags: 65536,
    });
    expect(tx.LPTokenIn).toEqual({
      currency: 'LP',
      issuer: ACCOUNT_C,
      value: '50',
    });
    expect(tx.Flags).toBe(65536);
  });

  it('includes Amount for single-asset withdraw', () => {
    const tx = buildAmmWithdraw({
      account: ACCOUNT_A,
      asset: { drops: '0' },
      asset2: { currency: 'USD', issuer: ACCOUNT_B },
      amount: { drops: '3000000' },
      flags: 524288,
    });
    expect(tx.Amount).toBe('3000000');
  });
});
