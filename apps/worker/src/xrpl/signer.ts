// Transaction signer abstraction. Master keys never leave this boundary.
//
// implementation rules enforced here:
//   - Never log signed blobs, seeds, or HSM responses.
//   - Master keys never leave the signer module — only signed tx_blob comes out.
//   - Errors thrown from this module MUST NOT contain transaction PII
//     (Destination, Amount, etc.) or any key material.
//
// In dev (Sprint 1+), DevSigner holds keys in-memory keyed by address. The
// keys themselves originate from the account creation flow and are persisted
// only as opaque references in `accounts.master_key_ref`.
//
// In prod, this interface is implemented by an HsmSigner that delegates to
// AWS CloudHSM (or YubiHSM). Same contract, real key isolation.
// TODO Sprint 1+: HsmSigner backend.

import { Wallet, encode } from 'xrpl';
import type { Transaction } from 'xrpl';

export interface SignedTransaction {
  tx_blob: string;
  hash: string;
}

/**
 * Sanitized signer error. Carries a category but never the original tx
 * payload or wallet material. Callers can match on `.category` to drive
 * retry logic without parsing strings.
 */
export class SignerError extends Error {
  constructor(
    public readonly category: 'no_key' | 'invalid_tx' | 'sign_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

export interface Signer {
  /**
   * Returns true if the signer holds a key for `address`. NOTE: this method
   * is for internal worker use only — exposing it via a public API would
   * leak which addresses RailForge manages.
   */
  hasKey(address: string): Promise<boolean>;

  /**
   * Signs a transaction. The transaction must be fully populated (Sequence,
   * LastLedgerSequence, Fee) — the signer does not auto-fill anything beyond
   * SigningPubKey/TxnSignature.
   *
   * The returned tx_blob is the only thing that should ever leave this method.
   * Internal key material must NEVER appear in logs, errors, or returned objects.
   *
   * On failure, throws {@link SignerError} with a category — never the
   * underlying xrpl.js validation error which can include tx PII.
   */
  sign(address: string, tx: Transaction): Promise<SignedTransaction>;
}

/**
 * In-memory dev signer. Sprint 1 default. Stores xrpl.js Wallet instances
 * keyed by classic address. Suitable for testnet only.
 *
 * Production deployments must replace this with HsmSigner. The constructor
 * refuses to start when NODE_ENV === 'production' to make accidental
 * production deploys impossible.
 */
export class DevSigner implements Signer {
  private wallets = new Map<string, Wallet>();

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DevSigner refuses to start in production. Use HsmSigner instead. ' +
          'See ARCHITECTURE.md §5.1 (Key vault).',
      );
    }
  }

  /**
   * Register a wallet with the signer. The seed/keys are taken from the Wallet
   * instance and stored only inside this Map — never persisted, logged, or
   * exposed via any other method.
   */
  registerWallet(wallet: Wallet): void {
    this.wallets.set(wallet.classicAddress, wallet);
  }

  /**
   * Generate a new wallet, register it, and return the address. The caller
   * does NOT receive the seed — that's the whole point of the signer boundary.
   * To get a usable testnet account, the account service should follow up by
   * funding the address from the faucet or treasury.
   */
  generateWallet(): { address: string } {
    const wallet = Wallet.generate();
    this.registerWallet(wallet);
    return { address: wallet.classicAddress };
  }

  /**
   * DEV-ONLY: generate a wallet and return BOTH the address AND the seed.
   *
   * This exists ONLY so the account service can persist the seed into
   * `accounts.master_key_ref` for cross-process signer coordination:
   *
   *   - API process generates + funds the wallet
   *   - Worker process reads master_key_ref from the DB and reconstructs
   *     the Wallet via loadFromSeed() when it needs to sign for that addr
   *
   * In production this method MUST NOT be called. `HsmSigner` will expose
   * `generateInHsm(): { address, keyHandle }` instead, where keyHandle is
   * an opaque CloudHSM reference that NEVER leaves the HSM boundary.
   *
   * The constructor refuses to start DevSigner when NODE_ENV=production,
   * so this method is unreachable in prod by design. But we also guard it
   * explicitly as belt-and-braces.
   */
  generateWalletWithSeed(): { address: string; seed: string } {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('generateWalletWithSeed() is dev-only and unreachable in production');
    }
    const wallet = Wallet.generate();
    if (!wallet.seed) {
      throw new Error('xrpl.js Wallet.generate() returned no seed (should never happen)');
    }
    this.registerWallet(wallet);
    return { address: wallet.classicAddress, seed: wallet.seed };
  }

  /**
   * DEV-ONLY: reconstruct a wallet from a persisted seed and register it.
   *
   * Used by the worker process to load a wallet into its signer from the
   * `accounts.master_key_ref` column before calling sign(). Same prod guard
   * as generateWalletWithSeed().
   */
  loadFromSeed(seed: string): { address: string } {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('loadFromSeed() is dev-only and unreachable in production');
    }
    const wallet = Wallet.fromSeed(seed);
    this.registerWallet(wallet);
    return { address: wallet.classicAddress };
  }

  async hasKey(address: string): Promise<boolean> {
    return this.wallets.has(address);
  }

  async sign(address: string, tx: Transaction): Promise<SignedTransaction> {
    const wallet = this.wallets.get(address);
    if (!wallet) {
      // Intentionally vague — never reveal which addresses we hold keys for.
      throw new SignerError('no_key', `No signing key available for ${address}`);
    }

    // xrpl.js Wallet.sign returns { tx_blob, hash } and never exposes the
    // private key in either field. We re-wrap to satisfy our SignedTransaction
    // type and to make this the single chokepoint for any future audit logging.
    //
    // CRITICAL: catch and sanitize. xrpl.js's ValidationError messages
    // include transaction properties (Destination, Amount). If a worker logs
    // the caught error, financial PII would leak. We re-throw a SignerError
    // with only the failure category — the original message is dropped.
    let result: ReturnType<Wallet['sign']>;
    try {
      result = wallet.sign(tx as Parameters<Wallet['sign']>[0]);
    } catch (err) {
      // We swallow the original error message on purpose. If you need to
      // diagnose a sign failure during dev, log the tx fields you control
      // BEFORE calling sign — never log the caught error here.
      const isValidation = err instanceof Error && err.constructor.name === 'ValidationError';
      throw new SignerError(
        isValidation ? 'invalid_tx' : 'sign_failed',
        isValidation ? 'Transaction validation failed' : 'Signing failed',
      );
    }

    return {
      tx_blob: result.tx_blob,
      hash: result.hash,
    };
  }
}

/**
 * Sanity helper used by tests and the tx submission pipeline. Encodes a
 * transaction to its canonical binary form WITHOUT signing — useful for
 * computing fees and inspecting payload size before involving the signer.
 *
 * Strips signature fields before encoding so a caller passing a partially-
 * signed tx (e.g., for re-fee-estimation) gets a clean unsigned blob.
 */
export function encodeUnsigned(tx: Transaction): string {
  // Drop any pre-existing signature material so the encoded blob represents
  // an unsigned tx as advertised. Without this, fee estimation on a partially
  // populated tx would include stale signature bytes in the size calculation.
  const { TxnSignature, Signers, SigningPubKey, ...clean } = tx as Transaction & {
    TxnSignature?: string;
    Signers?: unknown;
    SigningPubKey?: string;
  };
  return encode(clean as Transaction);
}
