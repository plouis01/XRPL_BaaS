// Tests for canonical xrpl-core transaction builders.
//
// Strategy: each builder is tested for (1) correct shape of the returned
// object, (2) optional fields only present when supplied, (3) validation
// errors on out-of-range inputs, and (4) round-trip through xrpl.js
// encode/decode — the strongest proof that the shape is well-formed.

import { describe, expect, it } from "vitest";
import { Wallet, decode, encode } from "xrpl";
import type { Transaction } from "xrpl";
import {
  buildAccountDelete,
  buildAccountSet,
  buildIssuedCurrencyPayment,
  buildMptIssuanceCreate,
  buildSignerListSet,
  buildTrustSet,
  buildXrpPayment,
} from "./transactions.ts";

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
    Fee: "12",
    LastLedgerSequence: 100,
    SigningPubKey: "",
  } as unknown as Transaction;
  const hex = encode(filled);
  return decode(hex) as unknown as T;
}

describe("buildXrpPayment", () => {
  it("produces a minimal XRP Payment", () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: "1000000",
    });
    expect(tx.TransactionType).toBe("Payment");
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Destination).toBe(ACCOUNT_B);
    expect(tx.Amount).toBe("1000000");
    expect(tx.DestinationTag).toBeUndefined();
    expect(tx.Memos).toBeUndefined();
  });

  it("includes DestinationTag when provided", () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: "100",
      destinationTag: 12345,
    });
    expect(tx.DestinationTag).toBe(12345);
  });

  it("encodes a memo as hex-uppercase UTF-8", () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: "100",
      memo: "hello",
    });
    const memoData = tx.Memos?.[0]?.Memo?.MemoData;
    expect(memoData).toBe("68656C6C6F"); // "hello" hex
  });

  it("round-trips through encode/decode", () => {
    const tx = buildXrpPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      amountDrops: "1000000",
      destinationTag: 1,
    });
    const rt = roundTrip(tx);
    expect(rt.Account).toBe(ACCOUNT_A);
    expect(rt.Destination).toBe(ACCOUNT_B);
    expect(rt.Amount).toBe("1000000");
    expect(rt.DestinationTag).toBe(1);
  });
});

describe("buildIssuedCurrencyPayment", () => {
  it("produces an issued-currency Payment with nested Amount", () => {
    const tx = buildIssuedCurrencyPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      currency: "USD",
      issuer: ACCOUNT_C,
      value: "100",
    });
    expect(tx.Amount).toEqual({
      currency: "USD",
      issuer: ACCOUNT_C,
      value: "100",
    });
  });

  it("round-trips through encode/decode", () => {
    const tx = buildIssuedCurrencyPayment({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
      currency: "USD",
      issuer: ACCOUNT_C,
      value: "100",
    });
    const rt = roundTrip(tx);
    expect(rt.Amount).toEqual({
      currency: "USD",
      issuer: ACCOUNT_C,
      value: "100",
    });
  });
});

describe("buildAccountSet", () => {
  it("produces a minimal AccountSet", () => {
    const tx = buildAccountSet({ account: ACCOUNT_A });
    expect(tx.TransactionType).toBe("AccountSet");
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.SetFlag).toBeUndefined();
    expect(tx.Domain).toBeUndefined();
  });

  it("includes SetFlag and ClearFlag when provided", () => {
    const tx = buildAccountSet({
      account: ACCOUNT_A,
      setFlag: 2,
      clearFlag: 3,
    });
    expect(tx.SetFlag).toBe(2);
    expect(tx.ClearFlag).toBe(3);
  });

  it("uppercases the domain hex", () => {
    const tx = buildAccountSet({ account: ACCOUNT_A, domain: "deadbeef" });
    expect(tx.Domain).toBe("DEADBEEF");
  });

  it("round-trips through encode/decode", () => {
    const tx = buildAccountSet({ account: ACCOUNT_A, setFlag: 1 });
    const rt = roundTrip(tx);
    expect(rt.Account).toBe(ACCOUNT_A);
    expect(rt.SetFlag).toBe(1);
  });
});

describe("buildSignerListSet", () => {
  it("produces a SignerListSet with nested SignerEntries", () => {
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

  it("throws on more than 32 entries", () => {
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

  it("throws on negative quorum", () => {
    expect(() =>
      buildSignerListSet({
        account: ACCOUNT_A,
        signerQuorum: -1,
        signerEntries: [{ address: ACCOUNT_B, weight: 1 }],
      }),
    ).toThrow(/>= 0/);
  });

  it("accepts quorum=0 + empty entries (signer list delete)", () => {
    const tx = buildSignerListSet({
      account: ACCOUNT_A,
      signerQuorum: 0,
      signerEntries: [],
    });
    expect(tx.SignerQuorum).toBe(0);
    expect(tx.SignerEntries).toEqual([]);
  });
});

describe("buildAccountDelete", () => {
  it("produces an AccountDelete", () => {
    const tx = buildAccountDelete({
      account: ACCOUNT_A,
      destination: ACCOUNT_B,
    });
    expect(tx.TransactionType).toBe("AccountDelete");
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.Destination).toBe(ACCOUNT_B);
  });

  it("round-trips through encode/decode", () => {
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

describe("buildMptIssuanceCreate", () => {
  it("produces a minimal MPTokenIssuanceCreate", () => {
    const tx = buildMptIssuanceCreate({ account: ACCOUNT_A });
    expect(tx.TransactionType).toBe("MPTokenIssuanceCreate");
    expect(tx.Account).toBe(ACCOUNT_A);
    expect(tx.AssetScale).toBeUndefined();
    expect(tx.TransferFee).toBeUndefined();
  });

  it("includes optional fields when provided", () => {
    const tx = buildMptIssuanceCreate({
      account: ACCOUNT_A,
      assetScale: 6,
      transferFee: 500, // 0.5%
      maximumAmount: "1000000000",
      flags: 0x04, // tfMPTCanTransfer
      mptMetadata: "deadbeef",
    });
    expect(tx.AssetScale).toBe(6);
    expect(tx.TransferFee).toBe(500);
    expect(tx.MaximumAmount).toBe("1000000000");
    expect(tx.Flags).toBe(0x04);
    expect(tx.MPTokenMetadata).toBe("DEADBEEF");
  });

  it("throws on transferFee > 50000", () => {
    expect(() =>
      buildMptIssuanceCreate({ account: ACCOUNT_A, transferFee: 50_001 }),
    ).toThrow(/0-50000/);
  });

  it("throws on negative transferFee", () => {
    expect(() =>
      buildMptIssuanceCreate({ account: ACCOUNT_A, transferFee: -1 }),
    ).toThrow(/0-50000/);
  });

  it("throws on assetScale out of range", () => {
    expect(() =>
      buildMptIssuanceCreate({ account: ACCOUNT_A, assetScale: 20 }),
    ).toThrow(/0-19/);
  });
});

describe("buildTrustSet", () => {
  it("produces a TrustSet with nested LimitAmount", () => {
    const tx = buildTrustSet({
      account: ACCOUNT_A,
      currency: "USD",
      issuer: ACCOUNT_B,
      limit: "1000000",
    });
    expect(tx.TransactionType).toBe("TrustSet");
    expect(tx.LimitAmount).toEqual({
      currency: "USD",
      issuer: ACCOUNT_B,
      value: "1000000",
    });
  });

  it("includes QualityIn/QualityOut when provided", () => {
    const tx = buildTrustSet({
      account: ACCOUNT_A,
      currency: "USD",
      issuer: ACCOUNT_B,
      limit: "100",
      qualityIn: 1_000_000_000,
      qualityOut: 999_000_000,
    });
    expect(tx.QualityIn).toBe(1_000_000_000);
    expect(tx.QualityOut).toBe(999_000_000);
  });

  it("round-trips through encode/decode", () => {
    const tx = buildTrustSet({
      account: ACCOUNT_A,
      currency: "USD",
      issuer: ACCOUNT_B,
      limit: "100",
    });
    const rt = roundTrip(tx);
    expect(rt.LimitAmount).toEqual({
      currency: "USD",
      issuer: ACCOUNT_B,
      value: "100",
    });
  });
});
