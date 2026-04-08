// Transaction signer abstraction. Master keys never leave this boundary.
//
// CLAUDE.md implementation rules:
//   - Never log signed blobs, seeds, or HSM responses.
//   - Master keys never leave the signer module — only signed tx_blob comes out.
//
// In dev (Sprint 1+), DevSigner holds keys in-memory keyed by address. The
// keys themselves originate from the account creation flow and are persisted
// only as opaque references in `accounts.master_key_ref`.
//
// In prod, this interface is implemented by an HsmSigner that delegates to
// AWS CloudHSM (or YubiHSM). Same contract, real key isolation.
// TODO Sprint 1+: HsmSigner backend.

import { Wallet, encode } from "xrpl";
import type { Transaction } from "xrpl";

export interface SignedTransaction {
  tx_blob: string;
  hash: string;
}

export interface Signer {
  /**
   * Returns the master/regular key pair address managed by this signer for the
   * given XRPL account. Used by callers that need to verify a signer can
   * actually sign for an address before queueing a transaction.
   */
  hasKey(address: string): Promise<boolean>;

  /**
   * Signs a transaction. The transaction must be fully populated (Sequence,
   * LastLedgerSequence, Fee) — the signer does not auto-fill anything beyond
   * SigningPubKey/TxnSignature.
   *
   * The returned tx_blob is the only thing that should ever leave this method.
   * Internal key material must NEVER appear in logs, errors, or returned objects.
   */
  sign(address: string, tx: Transaction): Promise<SignedTransaction>;
}

/**
 * In-memory dev signer. Sprint 1 default. Stores xrpl.js Wallet instances
 * keyed by classic address. Suitable for testnet only.
 *
 * Production deployments must replace this with HsmSigner.
 */
export class DevSigner implements Signer {
  private wallets = new Map<string, Wallet>();

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

  async hasKey(address: string): Promise<boolean> {
    return this.wallets.has(address);
  }

  async sign(address: string, tx: Transaction): Promise<SignedTransaction> {
    const wallet = this.wallets.get(address);
    if (!wallet) {
      // Intentionally vague — never reveal which addresses we hold keys for.
      throw new Error(`No signing key available for ${address}`);
    }

    // xrpl.js Wallet.sign returns { tx_blob, hash } and never exposes the
    // private key in either field. We re-wrap to satisfy our SignedTransaction
    // type and to make this the single chokepoint for any future audit logging.
    const result = wallet.sign(tx as Parameters<Wallet["sign"]>[0]);
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
 */
export function encodeUnsigned(tx: Transaction): string {
  return encode(tx);
}
