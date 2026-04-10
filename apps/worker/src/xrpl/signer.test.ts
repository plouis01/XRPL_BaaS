// Tests for the DevSigner contract. The signer is the boundary that prevents
// XRPL master keys from leaking. The contract MUST NOT change without
// re-running these tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Wallet } from 'xrpl';
import type { Transaction } from 'xrpl';
import { DevSigner, SignerError, encodeUnsigned } from './signer.ts';

// xrpl.js validates Account/Destination as real base58-checksum r-addresses
// before signing, so test fixtures use a real generated wallet for the
// destination instead of a placeholder string.
const DESTINATION_WALLET = Wallet.generate();

function makePaymentTx(account: string): Transaction {
  return {
    TransactionType: 'Payment',
    Account: account,
    Destination: DESTINATION_WALLET.classicAddress,
    Amount: '1000000',
    Sequence: 1,
    Fee: '12',
    LastLedgerSequence: 100,
  };
}

describe('DevSigner', () => {
  it('hasKey returns false for unregistered addresses', async () => {
    const signer = new DevSigner();
    expect(await signer.hasKey('rNeverRegistered')).toBe(false);
  });

  it('hasKey returns true after registerWallet', async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);
    expect(await signer.hasKey(wallet.classicAddress)).toBe(true);
  });

  it('generateWallet adds the new wallet and returns only the address', () => {
    const signer = new DevSigner();
    const result = signer.generateWallet();

    // Returned object exposes ONLY the address — no seed, no keys.
    expect(Object.keys(result)).toEqual(['address']);
    expect(result.address).toMatch(/^r/);
    // The wallet must actually be registered.
    return expect(signer.hasKey(result.address)).resolves.toBe(true);
  });

  it('returned wallet object from generateWallet has no seed-leaking fields', () => {
    const signer = new DevSigner();
    const result = signer.generateWallet();
    const json = JSON.stringify(result);

    // Common seed/key field names must NOT appear in the returned object.
    expect(json).not.toMatch(/seed/i);
    expect(json).not.toMatch(/private/i);
    expect(json).not.toMatch(/secret/i);
  });

  it('sign() rejects unknown addresses with SignerError(no_key) and a vague message', async () => {
    const signer = new DevSigner();
    const known = Wallet.generate();
    signer.registerWallet(known);

    const unknownAddress = 'rUnknownAddress00000000000000000000';

    let unknownErr: unknown = null;
    try {
      await signer.sign(unknownAddress, makePaymentTx(unknownAddress));
    } catch (e) {
      unknownErr = e;
    }

    // Strong contract: it's a SignerError, the category is 'no_key', and
    // the message does not leak whether the address exists in the wallet map.
    expect(unknownErr).toBeInstanceOf(SignerError);
    expect((unknownErr as SignerError).category).toBe('no_key');
    expect((unknownErr as Error).message).toMatch(/No signing key available/);
    expect((unknownErr as Error).message).not.toMatch(/wallet/i);
    expect((unknownErr as Error).message).not.toMatch(/found/i);
  });

  it('sign() wraps xrpl.js ValidationError as SignerError(invalid_tx) — original tx PII is dropped', async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);

    // Construct a tx that xrpl.js will reject during validation by including
    // a forbidden TxnSignature field. xrpl.js's ValidationError message would
    // normally include "TxnSignature" — we verify it's been replaced with our
    // generic SignerError message instead.
    const malformed = {
      ...makePaymentTx(wallet.classicAddress),
      TxnSignature: 'DEADBEEF_LEAKED_SIG_FIELD',
    } as Transaction;

    let err: unknown = null;
    try {
      await signer.sign(wallet.classicAddress, malformed);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(SignerError);
    expect((err as SignerError).category).toBe('invalid_tx');
    // The original ValidationError message (which includes "TxnSignature")
    // must NOT bleed through. Generic message only.
    expect((err as Error).message).toBe('Transaction validation failed');
    expect((err as Error).message).not.toContain('TxnSignature');
    expect((err as Error).message).not.toContain('DEADBEEF_LEAKED_SIG_FIELD');
  });

  it('sign() returns ONLY tx_blob and hash, no extra fields', async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);

    const tx = makePaymentTx(wallet.classicAddress);
    const result = await signer.sign(wallet.classicAddress, tx);

    // The returned object must have EXACTLY two keys. If xrpl.js ever adds a
    // new field to its Wallet.sign result, this test fails and forces us to
    // explicitly decide whether the new field is safe to expose.
    expect(Object.keys(result).sort()).toEqual(['hash', 'tx_blob']);
    expect(result.tx_blob).toBeTypeOf('string');
    expect(result.hash).toBeTypeOf('string');
    expect(result.tx_blob.length).toBeGreaterThan(0);
    expect(result.hash.length).toBe(64); // SHA-512Half hex
  });

  it('sign() output does not contain the seed or private key as a substring', async () => {
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

  it('two registered wallets can each sign their own transactions independently', async () => {
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

describe('DevSigner production guard', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('refuses to construct in production (forces a deliberate HsmSigner choice)', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new DevSigner()).toThrow(/refuses to start in production/);
  });

  it('constructs normally in development', () => {
    process.env.NODE_ENV = 'development';
    expect(() => new DevSigner()).not.toThrow();
  });

  it('constructs normally in test (vitest sets NODE_ENV=test)', () => {
    process.env.NODE_ENV = 'test';
    expect(() => new DevSigner()).not.toThrow();
  });
});

describe('DevSigner.loadKey', () => {
  it('loads a seed and makes the address available for signing', async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    await signer.loadKey(wallet.classicAddress, wallet.seed!);
    expect(await signer.hasKey(wallet.classicAddress)).toBe(true);
  });

  it('is a no-op when the address is already loaded', async () => {
    const signer = new DevSigner();
    const wallet = Wallet.generate();
    signer.registerWallet(wallet);
    await signer.loadKey(wallet.classicAddress, wallet.seed!);
    expect(await signer.hasKey(wallet.classicAddress)).toBe(true);
  });

  it('throws SignerError(no_key) when seed decodes to a different address', async () => {
    const signer = new DevSigner();
    const walletA = Wallet.generate();
    const walletB = Wallet.generate();
    // Load walletA's seed but claim it belongs to walletB's address
    await expect(signer.loadKey(walletB.classicAddress, walletA.seed!)).rejects.toThrow(
      SignerError,
    );
    // The mismatched wallet must NOT remain registered
    expect(await signer.hasKey(walletA.classicAddress)).toBe(false);
    expect(await signer.hasKey(walletB.classicAddress)).toBe(false);
  });

  it('throws on an invalid seed string', async () => {
    const signer = new DevSigner();
    await expect(signer.loadKey('rSomeAddr', 'not-a-valid-seed')).rejects.toThrow();
  });
});

describe('encodeUnsigned', () => {
  it('produces a hex string from a transaction', () => {
    const wallet = Wallet.generate();
    const tx = makePaymentTx(wallet.classicAddress);
    const blob = encodeUnsigned(tx);
    expect(blob).toBeTypeOf('string');
    expect(blob).toMatch(/^[0-9A-F]+$/);
  });

  it('strips TxnSignature, Signers, and SigningPubKey before encoding (so fee estimation is clean)', () => {
    const wallet = Wallet.generate();
    const cleanTx = makePaymentTx(wallet.classicAddress);

    // Tx with stale signature material — encodeUnsigned must drop it.
    const dirtyTx = {
      ...cleanTx,
      TxnSignature: '30440220AAAA',
      SigningPubKey: 'ED1234567890',
    } as Transaction;

    const cleanBlob = encodeUnsigned(cleanTx);
    const cleanedDirtyBlob = encodeUnsigned(dirtyTx);

    // Without stripping, the dirty blob would include the signature bytes
    // and be longer than the clean blob. With stripping, both encode to the
    // same canonical unsigned form.
    expect(cleanedDirtyBlob).toBe(cleanBlob);
  });
});
