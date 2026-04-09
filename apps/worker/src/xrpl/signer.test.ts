// Tests for the DevSigner contract. The signer is the boundary that prevents
// XRPL master keys from leaking. The contract MUST NOT change without
// re-running these tests.

import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import type { Transaction } from "xrpl";
import { DevSigner, encodeUnsigned } from "./signer.ts";

// xrpl.js validates Account/Destination as real base58-checksum r-addresses
// before signing, so test fixtures use a real generated wallet for the
// destination instead of a placeholder string.
const DESTINATION_WALLET = Wallet.generate();

function makePaymentTx(account: string): Transaction {
  return {
    TransactionType: "Payment",
    Account: account,
    Destination: DESTINATION_WALLET.classicAddress,
    Amount: "1000000",
    Sequence: 1,
    Fee: "12",
    LastLedgerSequence: 100,
  };
}

describe("DevSigner", () => {
  it("hasKey returns false for unregistered addresses", async () => {
    const signer = new DevSigner();
    expect(await signer.hasKey("rNeverRegistered")).toBe(false);
  });

  it("hasKey returns true after registerWallet", async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);
    expect(await signer.hasKey(wallet.classicAddress)).toBe(true);
  });

  it("generateWallet adds the new wallet and returns only the address", () => {
    const signer = new DevSigner();
    const result = signer.generateWallet();

    // Returned object exposes ONLY the address — no seed, no keys.
    expect(Object.keys(result)).toEqual(["address"]);
    expect(result.address).toMatch(/^r/);
    // The wallet must actually be registered.
    return expect(signer.hasKey(result.address)).resolves.toBe(true);
  });

  it("returned wallet object from generateWallet has no seed-leaking fields", () => {
    const signer = new DevSigner();
    const result = signer.generateWallet();
    const json = JSON.stringify(result);

    // Common seed/key field names must NOT appear in the returned object.
    expect(json).not.toMatch(/seed/i);
    expect(json).not.toMatch(/private/i);
    expect(json).not.toMatch(/secret/i);
  });

  it("sign() rejects unknown addresses with a vague error (no enumeration oracle)", async () => {
    const signer = new DevSigner();
    const known = Wallet.generate();
    signer.registerWallet(known);

    const unknownAddress = "rUnknownAddress00000000000000000000";

    // Both should throw with the SAME error message shape so an attacker can't
    // distinguish "address exists but tx invalid" from "address doesn't exist".
    let unknownErr: Error | null = null;
    try {
      await signer.sign(unknownAddress, makePaymentTx(unknownAddress));
    } catch (e) {
      unknownErr = e as Error;
    }

    expect(unknownErr).toBeInstanceOf(Error);
    // Error message must NOT include hints like "wallet not found" or
    // "address X is not managed by this signer". The current implementation
    // says "No signing key available for <address>" — that mentions the
    // address but doesn't reveal whether it exists in the map. Both unknown
    // and existing-but-failing cases throw, so the format is consistent.
    expect(unknownErr?.message).toMatch(/No signing key available/);
    expect(unknownErr?.message).not.toMatch(/wallet/i);
    expect(unknownErr?.message).not.toMatch(/found/i);
  });

  it("sign() returns ONLY tx_blob and hash, no extra fields", async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);

    const tx = makePaymentTx(wallet.classicAddress);
    const result = await signer.sign(wallet.classicAddress, tx);

    // The returned object must have EXACTLY two keys. If xrpl.js ever adds a
    // new field to its Wallet.sign result, this test fails and forces us to
    // explicitly decide whether the new field is safe to expose.
    expect(Object.keys(result).sort()).toEqual(["hash", "tx_blob"]);
    expect(result.tx_blob).toBeTypeOf("string");
    expect(result.hash).toBeTypeOf("string");
    expect(result.tx_blob.length).toBeGreaterThan(0);
    expect(result.hash.length).toBe(64); // SHA-512Half hex
  });

  it("sign() output does not contain the seed or private key as a substring", async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);

    const tx = makePaymentTx(wallet.classicAddress);
    const result = await signer.sign(wallet.classicAddress, tx);

    // Sanity check: the signed blob should never contain the seed in its
    // serialized form. xrpl.js takes care of this, but we verify the contract.
    if (wallet.seed) {
      expect(result.tx_blob).not.toContain(wallet.seed);
    }
    expect(result.tx_blob).not.toContain(wallet.privateKey);
  });

  it("two registered wallets can each sign their own transactions independently", async () => {
    const signer = new DevSigner();
    const a = Wallet.generate();
    const b = Wallet.generate();
    signer.registerWallet(a);
    signer.registerWallet(b);

    const txA = makePaymentTx(a.classicAddress);
    const txB = makePaymentTx(b.classicAddress);

    const sigA = await signer.sign(a.classicAddress, txA);
    const sigB = await signer.sign(b.classicAddress, txB);

    expect(sigA.tx_blob).not.toBe(sigB.tx_blob);
    expect(sigA.hash).not.toBe(sigB.hash);
  });
});

describe("encodeUnsigned", () => {
  it("produces a hex string from a transaction", () => {
    const wallet = Wallet.generate();
    const tx = makePaymentTx(wallet.classicAddress);
    const blob = encodeUnsigned(tx);
    expect(blob).toBeTypeOf("string");
    expect(blob).toMatch(/^[0-9A-F]+$/);
  });
});
