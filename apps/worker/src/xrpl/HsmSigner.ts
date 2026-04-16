// AWS CloudHSM-backed signer. Production counterpart to DevSigner.
//
// The Signer interface is HSM-shaped already (loadKey takes an opaque ref).
// In production, `ref` is a PKCS#11 object LABEL; the actual private key
// never leaves the HSM boundary. Signing happens inside the HSM — only
// the DER-encoded signature comes back out.
//
// CRITICAL rules enforced by this module:
//   - Never log key handles, signed blobs, signatures, or any HSM response
//     buffer. See packages/logger/src/index.ts REDACT_PATHS.
//   - Constructor refuses to run outside production (belt-and-braces: the
//     factory that picks DevSigner vs HsmSigner gates on env, but this
//     guards against a direct `new HsmSigner()` slip.)
//   - `modulePath` points at the CloudHSM PKCS#11 shared library
//     (/opt/cloudhsm/lib/libcloudhsm_pkcs11.so). That library is
//     Linux-only — the constructor succeeds on macOS (for unit tests
//     that mock pkcs11js), but `loadKey`/`sign` will throw at library
//     load time without a real HSM client daemon running.
//
// XRPL signing flow:
//   1. Strip any signature fields (TxnSignature/Signers/SigningPubKey).
//   2. `encodeForSigning(tx)` prepends HashPrefix `STX\0` and returns hex.
//   3. SHA-512 the bytes and take the first 32 bytes ("SHA-512 Half").
//   4. `C_Sign(CKM_ECDSA)` returns raw 64-byte `r || s`.
//   5. Normalize to low-S (secp256k1 malleability fix; XRPL requires it).
//   6. Encode r,s as ASN.1 DER.
//   7. Attach SigningPubKey (33-byte compressed pubkey, hex) + TxnSignature
//      (DER, hex) to the tx, `encode()` to canonical binary = tx_blob.
//   8. `hashSignedTx(tx_blob)` → hash.
//
// Key identity:
//   Each managed account's HSM keypair is created with a CKA_LABEL of
//   `railforge:<xrpl-address>`. `loadKey(address, label)` FindObjects by
//   that label, extracts `CKA_EC_POINT`, compresses it to 33 bytes, and
//   caches { privateKeyHandle, publicKeyHandle, compressedPubkey } for
//   subsequent sign calls. A worker restart drops the cache and reloads
//   lazily via the same code path that DevSigner uses.

import { createHash } from 'node:crypto';
import pkcs11js, { type Handle, PKCS11 } from 'pkcs11js';
import { encode } from 'xrpl';
import type { Transaction } from 'xrpl';
import { hashes, deriveAddress as xrplDeriveAddress } from 'xrpl';
import { encodeForSigning } from 'xrpl';
import { type SignedTransaction, type Signer, SignerError } from './signer.ts';

/**
 * ASN.1 DER encoding of OID 1.3.132.0.10 (secp256k1).
 * CloudHSM expects this as CKA_EC_PARAMS when generating an EC keypair.
 */
const SECP256K1_OID_DER = Buffer.from([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);

/**
 * secp256k1 curve order n. Used to normalize signatures to low-S form.
 * XRPL rejects high-S signatures (malleability defense). CloudHSM may
 * return either form — we always reduce to low-S here.
 */
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_N_HALF = SECP256K1_N / 2n;

/** PKCS#11 PIN format for CloudHSM: `CU_USERNAME:CU_PASSWORD`. */
export interface HsmConfig {
  /** PKCS#11 slot ID. CloudHSM defaults to 0. */
  slotId: number;
  /** PIN in the form `<cu-username>:<cu-password>`. Never logged. */
  pin: string;
  /** Path to the PKCS#11 shared library. Linux-only for CloudHSM. */
  modulePath: string;
}

/**
 * Cached entry for a loaded key. `privateKeyHandle` is the PKCS#11 handle
 * used by C_Sign. `compressedPubkey` is the 33-byte secp256k1 pubkey we
 * put in SigningPubKey on every signed tx.
 */
interface LoadedKey {
  privateKeyHandle: Handle;
  compressedPubkey: Buffer;
}

/**
 * AWS CloudHSM / SoftHSM signer. Implements the same Signer interface as
 * DevSigner but delegates all cryptographic operations to the HSM.
 *
 * Lifecycle:
 *   1. First `loadKey` call initializes the PKCS#11 session (lazy init).
 *   2. Each `loadKey` caches a handle + compressed pubkey for the address.
 *   3. `sign` looks up the cache; no HSM round-trip for the pubkey.
 *   4. `close()` logs out, closes the session, and calls C_Finalize.
 *
 * The class is safe to instantiate on macOS (tests mock pkcs11js entirely),
 * but actually signing requires the CloudHSM client daemon + a Linux host.
 */
export class HsmSigner implements Signer {
  private keys = new Map<string, LoadedKey>();
  private config: HsmConfig;
  private pkcs11: PKCS11;
  private session: Handle | null = null;
  private initialized = false;
  private loggedIn = false;

  constructor(config: HsmConfig) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(
        'HsmSigner is production-only. Use DevSigner for development. ' +
          'See ARCHITECTURE.md §5.1 (Key vault).',
      );
    }
    this.config = config;
    this.pkcs11 = new PKCS11();
  }

  async hasKey(address: string): Promise<boolean> {
    return this.keys.has(address);
  }

  /**
   * Lazy: load the PKCS#11 library, call C_Initialize, open a session,
   * and login as the Crypto User. Idempotent — subsequent calls are
   * no-ops. Re-invoked after a `close()` to reconnect.
   *
   * This is split out of the constructor because constructing the class
   * must not touch the network (tests construct freely).
   */
  private ensureInitialized(): void {
    if (this.initialized) return;
    this.pkcs11.load(this.config.modulePath);
    this.pkcs11.C_Initialize();
    this.initialized = true;

    // Pick the configured slot. CloudHSM exposes its cluster as a single
    // slot; we don't iterate — we trust the operator's HSM_SLOT value.
    const slots = this.pkcs11.C_GetSlotList(true);
    const slotBuf = slots[this.config.slotId];
    if (!slotBuf) {
      throw new SignerError('sign_failed', `HSM slot ${this.config.slotId} not present`);
    }

    // SERIAL_SESSION | RW_SESSION. We need RW to generate keys.
    const CKF_RW_SESSION = 0x00000002;
    const CKF_SERIAL_SESSION = 0x00000004;
    this.session = this.pkcs11.C_OpenSession(slotBuf, CKF_SERIAL_SESSION | CKF_RW_SESSION);
    this.ensureLoggedIn();
  }

  private ensureLoggedIn(): void {
    if (this.loggedIn || !this.session) return;
    // CKU_USER = 1 (Crypto User for CloudHSM).
    this.pkcs11.C_Login(this.session, 1, this.config.pin);
    this.loggedIn = true;
  }

  /**
   * Look up a private key by CKA_LABEL, extract the matching public key,
   * and cache the handle + compressed pubkey for use by `sign()`.
   *
   * `ref` is the PKCS#11 label — the convention is
   * `railforge:<classic-address>`. Account.service writes this into
   * `accounts.master_key_ref` when the key is generated via generateInHsm.
   */
  async loadKey(address: string, ref: string): Promise<void> {
    if (this.keys.has(address)) return;
    if (!ref || ref.length === 0) {
      throw new SignerError('no_key', 'Empty HSM key label');
    }

    this.ensureInitialized();
    const session = this.session;
    if (!session) throw new SignerError('sign_failed', 'HSM session not open');

    try {
      const privateKeyHandle = this.findObjectByLabel(session, ref, pkcs11js.CKO_PRIVATE_KEY);
      if (!privateKeyHandle) {
        throw new SignerError('no_key', 'Private key not found in HSM');
      }
      const publicKeyHandle = this.findObjectByLabel(session, ref, pkcs11js.CKO_PUBLIC_KEY);
      if (!publicKeyHandle) {
        throw new SignerError('no_key', 'Public key not found in HSM');
      }

      const compressedPubkey = this.extractCompressedPubkey(session, publicKeyHandle);
      this.keys.set(address, { privateKeyHandle, compressedPubkey });
    } catch (err) {
      if (err instanceof SignerError) throw err;
      // Sanitize — never let a raw pkcs11 error propagate with PII.
      throw new SignerError('no_key', 'Failed to load key from HSM');
    }
  }

  private findObjectByLabel(session: Handle, label: string, objectClass: number): Handle | null {
    const template = [
      { type: pkcs11js.CKA_CLASS, value: objectClass },
      { type: pkcs11js.CKA_LABEL, value: label },
    ];
    this.pkcs11.C_FindObjectsInit(session, template);
    try {
      const handles = this.pkcs11.C_FindObjects(session, 1);
      return handles[0] ?? null;
    } finally {
      this.pkcs11.C_FindObjectsFinal(session);
    }
  }

  /**
   * Read CKA_EC_POINT from the public key object and return the
   * 33-byte compressed secp256k1 pubkey.
   *
   * CKA_EC_POINT is wrapped in an ASN.1 OCTET STRING: 04 <len> 04 X Y.
   * We strip the wrapper and 04-prefix (uncompressed indicator), then
   * compress to 02/03 || X based on Y's parity.
   */
  private extractCompressedPubkey(session: Handle, pubkeyHandle: Handle): Buffer {
    const attrs = this.pkcs11.C_GetAttributeValue(session, pubkeyHandle, [
      { type: pkcs11js.CKA_EC_POINT },
    ]);
    const ecPoint = attrs[0]?.value;
    if (!Buffer.isBuffer(ecPoint)) {
      throw new SignerError('no_key', 'HSM returned invalid EC point');
    }
    return compressSecp256k1Pubkey(ecPoint);
  }

  /**
   * Sign a transaction using the HSM. The unsigned tx is serialized via
   * xrpl.js `encodeForSigning` (which prepends the STX HashPrefix),
   * hashed with SHA-512 half, signed via C_Sign(CKM_ECDSA), the raw r||s
   * is normalized to low-S and DER-encoded, attached to the tx, and the
   * resulting blob is encoded + hashed.
   */
  async sign(address: string, tx: Transaction): Promise<SignedTransaction> {
    const loaded = this.keys.get(address);
    if (!loaded) {
      throw new SignerError('no_key', `No HSM key loaded for ${address}`);
    }
    this.ensureInitialized();
    const session = this.session;
    if (!session) throw new SignerError('sign_failed', 'HSM session not open');

    // Strip pre-existing signature fields; xrpl.js's encodeForSigning
    // does this implicitly but being explicit keeps the error messages
    // readable if the tx shape is broken.
    const unsignedTx = stripSignatureFields(tx);

    // 1. Set SigningPubKey BEFORE encodeForSigning — XRPL's canonical
    // signing bytes include the pubkey, so omitting it produces a hash
    // that won't match on the receiving side.
    const txWithPubkey = {
      ...unsignedTx,
      SigningPubKey: loaded.compressedPubkey.toString('hex').toUpperCase(),
    };

    let signingBytes: Buffer;
    try {
      const hex = encodeForSigning(txWithPubkey as Transaction);
      signingBytes = Buffer.from(hex, 'hex');
    } catch {
      throw new SignerError('invalid_tx', 'Transaction serialization failed');
    }

    // 2. SHA-512 half. XRPL's hash input for signing is the first 32
    // bytes of SHA-512 of the prefix + encoded tx.
    const hashInput = createHash('sha512').update(signingBytes).digest().subarray(0, 32);

    // 3. C_Sign with CKM_ECDSA returns raw r || s (64 bytes for secp256k1).
    let rawSig: Buffer;
    try {
      this.ensureLoggedIn();
      this.pkcs11.C_SignInit(session, { mechanism: pkcs11js.CKM_ECDSA }, loaded.privateKeyHandle);
      rawSig = this.pkcs11.C_Sign(session, hashInput, Buffer.alloc(64));
    } catch (err) {
      // Session may have expired — retry once after re-login.
      if (isNotLoggedInError(err)) {
        this.loggedIn = false;
        this.ensureLoggedIn();
        this.pkcs11.C_SignInit(session, { mechanism: pkcs11js.CKM_ECDSA }, loaded.privateKeyHandle);
        rawSig = this.pkcs11.C_Sign(session, hashInput, Buffer.alloc(64));
      } else {
        throw new SignerError('sign_failed', 'HSM signing failed');
      }
    }

    if (rawSig.length !== 64) {
      throw new SignerError('sign_failed', 'HSM returned unexpected signature length');
    }

    // 4. Low-S normalization + DER encode.
    const derSig = rawEcdsaToDer(rawSig);

    // 5. Attach TxnSignature, encode, hash.
    const signedTx = {
      ...txWithPubkey,
      TxnSignature: derSig.toString('hex').toUpperCase(),
    };
    const tx_blob = encode(signedTx as Transaction);
    const hash = hashes.hashSignedTx(tx_blob);

    return { tx_blob, hash };
  }

  /**
   * Generate a new secp256k1 keypair INSIDE the HSM. Returns the XRPL
   * classic address derived from the public key and the PKCS#11 label
   * used to find the keypair on subsequent loadKey calls.
   *
   * The private key never leaves the HSM. `CKA_TOKEN=true` persists the
   * key across HSM sessions — a worker restart can find it by label.
   */
  async generateInHsm(): Promise<{ address: string; keyHandle: string }> {
    this.ensureInitialized();
    const session = this.session;
    if (!session) throw new SignerError('sign_failed', 'HSM session not open');

    // Temporary label during generation; we rename to the canonical
    // `railforge:<address>` label once we've derived the address. This
    // two-step ceremony is necessary because the address depends on the
    // pubkey, which only exists after generation.
    const tempLabel = `railforge:pending:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    const publicKeyTemplate = [
      { type: pkcs11js.CKA_TOKEN, value: true },
      { type: pkcs11js.CKA_PRIVATE, value: false },
      { type: pkcs11js.CKA_VERIFY, value: true },
      { type: pkcs11js.CKA_EC_PARAMS, value: SECP256K1_OID_DER },
      { type: pkcs11js.CKA_LABEL, value: tempLabel },
    ];
    const privateKeyTemplate = [
      { type: pkcs11js.CKA_TOKEN, value: true },
      { type: pkcs11js.CKA_PRIVATE, value: true },
      { type: pkcs11js.CKA_SENSITIVE, value: true },
      { type: pkcs11js.CKA_EXTRACTABLE, value: false },
      { type: pkcs11js.CKA_SIGN, value: true },
      { type: pkcs11js.CKA_LABEL, value: tempLabel },
    ];

    this.ensureLoggedIn();
    const keys = this.pkcs11.C_GenerateKeyPair(
      session,
      { mechanism: pkcs11js.CKM_EC_KEY_PAIR_GEN },
      publicKeyTemplate,
      privateKeyTemplate,
    );

    const compressedPubkey = this.extractCompressedPubkey(session, keys.publicKey);
    const address = xrplDeriveAddress(compressedPubkey.toString('hex').toUpperCase());
    const finalLabel = `railforge:${address}`;

    // Rename both objects to the canonical label. C_SetAttributeValue is
    // one call per object.
    this.pkcs11.C_SetAttributeValue(session, keys.publicKey, [
      { type: pkcs11js.CKA_LABEL, value: finalLabel },
    ]);
    this.pkcs11.C_SetAttributeValue(session, keys.privateKey, [
      { type: pkcs11js.CKA_LABEL, value: finalLabel },
    ]);

    // Pre-populate the cache so the caller can sign immediately without
    // re-finding the key by label.
    this.keys.set(address, {
      privateKeyHandle: keys.privateKey,
      compressedPubkey,
    });

    return { address, keyHandle: finalLabel };
  }

  /** Close the PKCS#11 session. Call on graceful shutdown. */
  async close(): Promise<void> {
    this.keys.clear();
    if (this.session) {
      try {
        if (this.loggedIn) {
          this.pkcs11.C_Logout(this.session);
        }
        this.pkcs11.C_CloseSession(this.session);
      } catch {
        // Best-effort — don't throw on shutdown.
      }
      this.session = null;
      this.loggedIn = false;
    }
    if (this.initialized) {
      try {
        this.pkcs11.C_Finalize();
        this.pkcs11.close();
      } catch {
        // Best-effort.
      }
      this.initialized = false;
    }
  }
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Convert a CKA_EC_POINT buffer into a 33-byte compressed secp256k1 pubkey.
 *
 * CKA_EC_POINT format per PKCS#11: ASN.1 OCTET STRING wrapping the raw EC
 * point. The raw point starts with 0x04 (uncompressed indicator) then 64
 * bytes of X||Y. We peel the OCTET STRING header (04 LEN) and the
 * uncompressed indicator, then compress.
 *
 * Exported so the test can feed a known wrapped point and check the output.
 */
export function compressSecp256k1Pubkey(ecPoint: Buffer): Buffer {
  // Peel the outer ASN.1 OCTET STRING if present. Format: 04 <len> <data>.
  // Supports both short-form (len < 128) and long-form (81 <len>).
  let raw: Buffer;
  const octetTag = ecPoint.length > 0 ? ecPoint[0] : undefined;
  const lenByte = ecPoint.length > 1 ? ecPoint[1] : undefined;
  if (octetTag === 0x04 && lenByte !== undefined) {
    if (lenByte < 0x80) {
      raw = ecPoint.subarray(2);
    } else if (lenByte === 0x81 && ecPoint.length >= 3) {
      raw = ecPoint.subarray(3);
    } else {
      raw = ecPoint;
    }
  } else {
    raw = ecPoint;
  }

  // Raw should be 0x04 || X(32) || Y(32) for an uncompressed point.
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new SignerError('no_key', 'Unexpected EC point encoding');
  }
  const x = raw.subarray(1, 33);
  const y = raw.subarray(33, 65);
  const yLastByte = y[y.length - 1];
  if (yLastByte === undefined) {
    throw new SignerError('no_key', 'Empty Y coordinate');
  }
  const prefix = (yLastByte & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

/**
 * Convert raw 64-byte secp256k1 signature (r || s) to ASN.1 DER encoding.
 * Normalizes s to the low half of the curve order to avoid the malleable
 * high-S form that XRPL rejects.
 *
 * Output shape:
 *   30 <total>
 *     02 <rlen> <r>
 *     02 <slen> <s>
 *
 * r and s are minimally encoded: leading zeros stripped, but a leading
 * 0x00 is prepended if the high bit would otherwise make the integer
 * appear negative in ASN.1.
 */
export function rawEcdsaToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) {
    throw new Error(`expected 64-byte raw signature, got ${raw.length}`);
  }
  const r = BigInt(`0x${raw.subarray(0, 32).toString('hex')}`);
  let s = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`);
  if (s > SECP256K1_N_HALF) {
    s = SECP256K1_N - s;
  }
  const rBytes = bigintToDerInt(r);
  const sBytes = bigintToDerInt(s);
  const total = rBytes.length + sBytes.length;
  return Buffer.concat([Buffer.from([0x30, total]), rBytes, sBytes]);
}

/**
 * Encode a positive bigint as a DER INTEGER. Minimal-length, with a
 * leading 0x00 pad when the high bit is set (so the integer isn't
 * misread as negative).
 */
function bigintToDerInt(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  // Strip leading zeros that aren't needed for the sign bit.
  while (bytes.length > 1) {
    const first = bytes[0];
    const second = bytes[1];
    if (first === 0 && second !== undefined && (second & 0x80) === 0) {
      bytes = bytes.subarray(1);
    } else {
      break;
    }
  }
  // Prepend 0x00 if the high bit is set.
  const first = bytes[0];
  if (first !== undefined && (first & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

/**
 * Strip signature-related fields from a transaction so encodeForSigning
 * doesn't choke and so replays don't accidentally re-sign stale data.
 */
function stripSignatureFields(tx: Transaction): Transaction {
  const { TxnSignature, Signers, SigningPubKey, ...clean } = tx as Transaction & {
    TxnSignature?: string;
    Signers?: unknown;
    SigningPubKey?: string;
  };
  return clean as Transaction;
}

/**
 * Detect CKR_USER_NOT_LOGGED_IN from a pkcs11 error. pkcs11js throws
 * an error whose `code` is the raw PKCS#11 error number (0x101 for this
 * condition). Rather than pull the constant in (layout-dependent), we
 * check by name on the message as well.
 */
function isNotLoggedInError(err: unknown): boolean {
  const CKR_USER_NOT_LOGGED_IN = 0x00000101;
  if (err && typeof err === 'object') {
    const code = (err as { code?: number }).code;
    if (code === CKR_USER_NOT_LOGGED_IN) return true;
    const message = (err as { message?: string }).message;
    if (typeof message === 'string' && message.includes('CKR_USER_NOT_LOGGED_IN')) return true;
  }
  return false;
}
