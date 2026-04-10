// AWS CloudHSM-backed signer. Production counterpart to DevSigner.
//
// The Signer interface is HSM-shaped already (loadKey takes an opaque ref).
// In production, `ref` is an AWS CloudHSM key handle; the key never leaves
// the HSM boundary. Signing happens inside the HSM — only the signed
// tx_blob comes out.
//
// CRITICAL: this module MUST NOT log key handles, signed blobs, or any
// CloudHSM response data. The same redact rules that apply to DevSigner
// apply here. See packages/logger/src/index.ts REDACT_PATHS.
//
// Sprint 3 implementation: the HSM integration is stubbed against the
// PKCS#11 interface that both AWS CloudHSM and SoftHSM expose. The
// actual PKCS#11 library binding (e.g., graphene-pk11 or pkcs11js) is
// added when the CloudHSM cluster is provisioned.
//
// For now, the class validates the contract, refuses to run outside
// production, and provides the wiring points for the real HSM calls.

import { encode } from 'xrpl';
import type { Transaction } from 'xrpl';
import { type SignedTransaction, type Signer, SignerError } from './signer.ts';

/**
 * Configuration for the HSM connection. In production these come from
 * environment variables (HSM_SLOT, HSM_PIN, HSM_MODULE_PATH).
 */
export interface HsmConfig {
  /** PKCS#11 slot ID for the CloudHSM partition. */
  slotId: number;
  /** HSM user PIN. Read from env, never logged. */
  pin: string;
  /** Path to the PKCS#11 shared library (.so / .dylib). */
  modulePath: string;
}

/**
 * AWS CloudHSM / SoftHSM signer. Implements the same Signer interface as
 * DevSigner but delegates all cryptographic operations to the HSM.
 *
 * Key lifecycle:
 *   1. Account creation generates a secp256k1 keypair INSIDE the HSM.
 *   2. The HSM returns a key handle (opaque string) — stored in
 *      `accounts.master_key_ref`.
 *   3. `loadKey(address, handle)` opens an HSM session and caches the
 *      session handle for subsequent sign() calls.
 *   4. `sign()` sends the serialized unsigned tx to the HSM, receives
 *      back the DER-encoded signature, and assembles the tx_blob.
 *
 * The private key NEVER leaves the HSM boundary at any point.
 */
export class HsmSigner implements Signer {
  private keyHandles = new Map<string, string>();
  private config: HsmConfig;
  // In the real implementation, this holds the PKCS#11 session handle.
  // Typed as `unknown` until the PKCS#11 binding is added.
  private session: unknown = null;

  constructor(config: HsmConfig) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        'HsmSigner is production-only. Use DevSigner for development. ' +
          'See ARCHITECTURE.md §5.1 (Key vault).',
      );
    }
    this.config = config;
    // TODO: initialize PKCS#11 session
    // this.session = initializePkcs11(config.modulePath, config.slotId, config.pin);
  }

  async hasKey(address: string): Promise<boolean> {
    return this.keyHandles.has(address);
  }

  /**
   * Load an HSM key handle for the given address. The `ref` is the opaque
   * CloudHSM key handle stored in `accounts.master_key_ref`.
   *
   * No-op if the address is already loaded.
   */
  async loadKey(address: string, ref: string): Promise<void> {
    if (this.keyHandles.has(address)) return;

    // Validate that the key handle exists in the HSM. In the real
    // implementation this would open a PKCS#11 FindObjects session
    // to verify the handle resolves to a secp256k1 private key.
    if (!ref || ref.length === 0) {
      throw new SignerError('no_key', 'Empty HSM key handle');
    }

    // TODO: verify key exists in HSM session
    // const keyObj = this.session.findObject({ handle: ref, class: 'PRIVATE_KEY' });
    // if (!keyObj) throw new SignerError('no_key', 'Key handle not found in HSM');

    this.keyHandles.set(address, ref);
  }

  /**
   * Sign a transaction using the HSM. The unsigned tx is serialized to
   * canonical binary, sent to the HSM for signing, and the resulting
   * signature is assembled into a tx_blob.
   *
   * CRITICAL: the private key never appears in this process's memory.
   * Only the DER-encoded signature comes back from the HSM.
   */
  async sign(address: string, tx: Transaction): Promise<SignedTransaction> {
    const keyHandle = this.keyHandles.get(address);
    if (!keyHandle) {
      throw new SignerError('no_key', `No HSM key handle loaded for ${address}`);
    }

    // 1. Validate the transaction is serializable (catches malformed tx
    // before we talk to the HSM).
    try {
      const { TxnSignature, Signers, SigningPubKey, ...clean } = tx as Transaction & {
        TxnSignature?: string;
        Signers?: unknown;
        SigningPubKey?: string;
      };
      encode(clean as Transaction);
    } catch {
      throw new SignerError('invalid_tx', 'Transaction serialization failed');
    }

    // 2. Send unsigned tx bytes to HSM for signing via PKCS#11.
    // 3. Assemble tx_blob with the DER-encoded signature from HSM.
    // TODO: wire PKCS#11 — provision CloudHSM and install the binding.
    throw new SignerError(
      'sign_failed',
      'HsmSigner PKCS#11 binding not yet connected. ' +
        'Provision CloudHSM and install the PKCS#11 library to enable.',
    );
  }

  /**
   * Generate a new secp256k1 keypair inside the HSM and return the
   * XRPL classic address + opaque key handle. The private key NEVER
   * leaves the HSM.
   *
   * TODO: implement when CloudHSM cluster is provisioned.
   */
  async generateInHsm(): Promise<{ address: string; keyHandle: string }> {
    // const { publicKey, privateKeyHandle } = this.session.generateKeyPair('ECDSA', 'secp256k1');
    // const address = deriveClassicAddress(publicKey);
    // this.keyHandles.set(address, privateKeyHandle);
    // return { address, keyHandle: privateKeyHandle };
    throw new SignerError('sign_failed', 'HsmSigner key generation not yet connected to CloudHSM.');
  }

  /**
   * Close the PKCS#11 session. Call on graceful shutdown.
   */
  async close(): Promise<void> {
    // TODO: this.session.close();
    this.keyHandles.clear();
    this.session = null;
  }
}
