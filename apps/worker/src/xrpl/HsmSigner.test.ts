// Unit tests for HsmSigner.
//
// Strategy: `pkcs11js` is fully mocked so the tests run on macOS (which
// can't load CloudHSM's Linux-only shared library) and without an HSM.
// The mock is stateful enough to exercise the session lifecycle, key
// caching, sign flow, and keypair generation. End-to-end signing against
// a real HSM is Phase 2 integration-test work — deferred until the EC2
// bastion has the CloudHSM client daemon installed.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignerError } from './signer.ts';

// ── pkcs11js mock ───────────────────────────────────────────────────────────
//
// vi.hoisted() lets the mock factory reference shared state + constants
// at module-evaluation time (vi.mock is hoisted above imports).

const { pkcs11Constants, mockState, MockPKCS11 } = vi.hoisted(() => {
  const pkcs11Constants = {
    CKA_CLASS: 0x00000000,
    CKA_LABEL: 0x00000003,
    CKA_EC_POINT: 0x00000181,
    CKA_EC_PARAMS: 0x00000180,
    CKA_TOKEN: 0x00000001,
    CKA_PRIVATE: 0x00000002,
    CKA_VERIFY: 0x0000010a,
    CKA_SIGN: 0x00000108,
    CKA_SENSITIVE: 0x00000103,
    CKA_EXTRACTABLE: 0x00000162,
    CKO_PRIVATE_KEY: 3,
    CKO_PUBLIC_KEY: 2,
    CKM_ECDSA: 0x00001041,
    CKM_EC_KEY_PAIR_GEN: 0x00001040,
  };

  // Known uncompressed secp256k1 point (pre-wrapped in ASN.1 OCTET STRING):
  //   04 41 04 <32-byte X> <32-byte Y>
  // Chosen so Y's last byte is odd → compressed prefix 0x03.
  const sampleEcPoint = Buffer.from(
    '0441' +
      '04' +
      '79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798' +
      '483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8',
    'hex',
  );

  interface State {
    loaded: boolean;
    initialized: boolean;
    sessionOpen: boolean;
    loggedIn: boolean;
    findTemplate: Array<{ type: number; value: unknown }> | null;
    objects: Map<number, { label: string; kind: 'private' | 'public' }>;
    nextHandle: number;
    rawSignature: Buffer;
    calls: {
      load: number;
      init: number;
      openSession: number;
      login: number;
      logout: number;
      closeSession: number;
      finalize: number;
      signInit: number;
      sign: number;
      keyPairGen: number;
      setAttribute: number;
    };
  }

  const mockState: State = {
    loaded: false,
    initialized: false,
    sessionOpen: false,
    loggedIn: false,
    findTemplate: null,
    objects: new Map(),
    nextHandle: 1,
    // Default: raw 64-byte r||s with low-S already. Tests that exercise
    // high-S override this with a fresh buffer.
    rawSignature: Buffer.alloc(64, 0xaa),
    calls: {
      load: 0,
      init: 0,
      openSession: 0,
      login: 0,
      logout: 0,
      closeSession: 0,
      finalize: 0,
      signInit: 0,
      sign: 0,
      keyPairGen: 0,
      setAttribute: 0,
    },
  };

  class MockPKCS11 {
    load(_path: string): void {
      mockState.calls.load++;
      mockState.loaded = true;
    }
    close(): void {
      mockState.loaded = false;
    }
    C_Initialize(): void {
      mockState.calls.init++;
      mockState.initialized = true;
    }
    C_Finalize(): void {
      mockState.calls.finalize++;
      mockState.initialized = false;
    }
    C_GetSlotList(_withToken: boolean): Buffer[] {
      return [Buffer.from([0x01])];
    }
    C_OpenSession(_slot: Buffer, _flags: number): Buffer {
      mockState.calls.openSession++;
      mockState.sessionOpen = true;
      return Buffer.from([0xaa]);
    }
    C_CloseSession(_session: Buffer): void {
      mockState.calls.closeSession++;
      mockState.sessionOpen = false;
    }
    C_Login(_session: Buffer, _userType: number, _pin?: string): void {
      mockState.calls.login++;
      mockState.loggedIn = true;
    }
    C_Logout(_session: Buffer): void {
      mockState.calls.logout++;
      mockState.loggedIn = false;
    }
    C_FindObjectsInit(_session: Buffer, template: Array<{ type: number; value: unknown }>): void {
      mockState.findTemplate = template;
    }
    C_FindObjects(_session: Buffer, _maxCount: number): Buffer[] {
      const labelEntry = mockState.findTemplate?.find((t) => t.type === pkcs11Constants.CKA_LABEL);
      const classEntry = mockState.findTemplate?.find((t) => t.type === pkcs11Constants.CKA_CLASS);
      if (!labelEntry || !classEntry) return [];
      const wantKind = classEntry.value === pkcs11Constants.CKO_PRIVATE_KEY ? 'private' : 'public';
      for (const [handle, obj] of mockState.objects) {
        if (obj.label === labelEntry.value && obj.kind === wantKind) {
          return [Buffer.from([handle])];
        }
      }
      return [];
    }
    C_FindObjectsFinal(_session: Buffer): void {
      mockState.findTemplate = null;
    }
    C_GetAttributeValue(
      _session: Buffer,
      _handle: Buffer,
      template: Array<{ type: number }>,
    ): Array<{ type: number; value: Buffer }> {
      return template.map((t) => {
        if (t.type === pkcs11Constants.CKA_EC_POINT) {
          return { type: t.type, value: sampleEcPoint };
        }
        return { type: t.type, value: Buffer.alloc(0) };
      });
    }
    C_SignInit(_session: Buffer, _mech: unknown, _key: Buffer): void {
      mockState.calls.signInit++;
    }
    C_Sign(_session: Buffer, _inData: Buffer, _outData: Buffer): Buffer {
      mockState.calls.sign++;
      return mockState.rawSignature;
    }
    C_GenerateKeyPair(
      _session: Buffer,
      _mech: unknown,
      pubTemplate: Array<{ type: number; value: unknown }>,
      _privTemplate: Array<{ type: number; value: unknown }>,
    ): { publicKey: Buffer; privateKey: Buffer } {
      mockState.calls.keyPairGen++;
      const labelEntry = pubTemplate.find((t) => t.type === pkcs11Constants.CKA_LABEL);
      const label = typeof labelEntry?.value === 'string' ? labelEntry.value : 'unknown';
      const pubHandle = mockState.nextHandle++;
      const privHandle = mockState.nextHandle++;
      mockState.objects.set(pubHandle, { label, kind: 'public' });
      mockState.objects.set(privHandle, { label, kind: 'private' });
      return {
        publicKey: Buffer.from([pubHandle]),
        privateKey: Buffer.from([privHandle]),
      };
    }
    C_SetAttributeValue(
      _session: Buffer,
      handle: Buffer,
      attrs: Array<{ type: number; value: unknown }>,
    ): void {
      mockState.calls.setAttribute++;
      const obj = mockState.objects.get(handle[0] ?? 0);
      if (!obj) return;
      const labelAttr = attrs.find((a) => a.type === pkcs11Constants.CKA_LABEL);
      if (labelAttr && typeof labelAttr.value === 'string') {
        obj.label = labelAttr.value;
      }
    }
  }

  return { pkcs11Constants, mockState, MockPKCS11 };
});

vi.mock('pkcs11js', () => {
  return {
    default: { ...pkcs11Constants },
    ...pkcs11Constants,
    PKCS11: MockPKCS11,
  };
});

// Import AFTER mocks.
const { HsmSigner, compressSecp256k1Pubkey, rawEcdsaToDer } = await import('./HsmSigner.ts');

function resetMockState(): void {
  mockState.loaded = false;
  mockState.initialized = false;
  mockState.sessionOpen = false;
  mockState.loggedIn = false;
  mockState.findTemplate = null;
  mockState.objects.clear();
  mockState.nextHandle = 1;
  mockState.rawSignature = Buffer.alloc(64, 0xaa);
  mockState.calls = {
    load: 0,
    init: 0,
    openSession: 0,
    login: 0,
    logout: 0,
    closeSession: 0,
    finalize: 0,
    signInit: 0,
    sign: 0,
    keyPairGen: 0,
    setAttribute: 0,
  };
}

describe('HsmSigner', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    resetMockState();
  });

  it('refuses to construct outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(
      () =>
        new HsmSigner({
          slotId: 0,
          pin: 'user:pass',
          modulePath: '/fake/path.so',
        }),
    ).toThrow(/production-only/);
  });

  it('constructs in production without touching the HSM', () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });
    // No PKCS#11 calls should have been made yet — the class is lazy.
    expect(mockState.calls.load).toBe(0);
    expect(mockState.calls.init).toBe(0);
    expect(mockState.calls.openSession).toBe(0);
    expect(signer).toBeDefined();
  });

  it('initializes the session exactly once across multiple loadKey calls', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });

    // Pre-seed two keypairs.
    mockState.objects.set(1, { label: 'railforge:rAlice', kind: 'private' });
    mockState.objects.set(2, { label: 'railforge:rAlice', kind: 'public' });
    mockState.objects.set(3, { label: 'railforge:rBob', kind: 'private' });
    mockState.objects.set(4, { label: 'railforge:rBob', kind: 'public' });

    await signer.loadKey('rAlice', 'railforge:rAlice');
    await signer.loadKey('rBob', 'railforge:rBob');

    expect(mockState.calls.load).toBe(1);
    expect(mockState.calls.init).toBe(1);
    expect(mockState.calls.openSession).toBe(1);
    expect(mockState.calls.login).toBe(1);
    expect(await signer.hasKey('rAlice')).toBe(true);
    expect(await signer.hasKey('rBob')).toBe(true);
  });

  it('loadKey is a no-op when address already cached', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });
    mockState.objects.set(1, { label: 'railforge:rAlice', kind: 'private' });
    mockState.objects.set(2, { label: 'railforge:rAlice', kind: 'public' });

    await signer.loadKey('rAlice', 'railforge:rAlice');
    await signer.loadKey('rAlice', 'railforge:rAlice'); // no-op

    expect(await signer.hasKey('rAlice')).toBe(true);
    // C_OpenSession was still only called once.
    expect(mockState.calls.openSession).toBe(1);
  });

  it('loadKey rejects an empty label', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });
    await expect(signer.loadKey('rAlice', '')).rejects.toThrow(SignerError);
  });

  it('loadKey throws no_key when the label is not found', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });
    // No objects in mockState.objects — FindObjects returns empty.
    const err = await signer.loadKey('rMissing', 'railforge:rMissing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect((err as InstanceType<typeof SignerError>).category).toBe('no_key');
  });

  it('sign throws no_key when address not loaded', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });
    const err = await signer
      .sign('rUnknown', {
        TransactionType: 'Payment',
        Account: 'rUnknown',
      } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect((err as InstanceType<typeof SignerError>).category).toBe('no_key');
  });

  it('sign produces a tx_blob and hash via the mocked HSM', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });

    // The sample EC point's compressed form resolves to a specific XRPL
    // address. We don't care which — we just need the signing pipeline
    // to produce a non-empty tx_blob and a valid-shape hash.
    mockState.objects.set(1, { label: 'railforge:test', kind: 'private' });
    mockState.objects.set(2, { label: 'railforge:test', kind: 'public' });
    await signer.loadKey('rTestSrc', 'railforge:test');

    // 64-byte low-S raw signature. Values chosen so neither r nor s has
    // the high bit set, so DER encoding doesn't need a 0x00 pad.
    mockState.rawSignature = Buffer.concat([
      Buffer.alloc(32, 0x11), // r
      Buffer.alloc(32, 0x22), // s
    ]);

    const result = await signer.sign('rTestSrc', {
      TransactionType: 'Payment',
      Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      Destination: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      Amount: '1000000',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
    } as never);

    expect(result.tx_blob).toMatch(/^[0-9A-F]+$/);
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(mockState.calls.signInit).toBe(1);
    expect(mockState.calls.sign).toBe(1);
  });

  it('generateInHsm creates a keypair, derives an address, relabels, and caches', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });

    const result = await signer.generateInHsm();

    expect(mockState.calls.keyPairGen).toBe(1);
    // Both pub+priv got relabeled to the canonical name.
    expect(mockState.calls.setAttribute).toBe(2);
    expect(result.address).toMatch(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
    expect(result.keyHandle).toBe(`railforge:${result.address}`);
    // The key is already cached, so sign() can proceed without a second load.
    expect(await signer.hasKey(result.address)).toBe(true);
  });

  it('close clears caches and finalizes the session', async () => {
    process.env.NODE_ENV = 'production';
    const signer = new HsmSigner({
      slotId: 0,
      pin: 'user:pass',
      modulePath: '/fake/path.so',
    });
    mockState.objects.set(1, { label: 'railforge:r1', kind: 'private' });
    mockState.objects.set(2, { label: 'railforge:r1', kind: 'public' });
    await signer.loadKey('rOne', 'railforge:r1');

    await signer.close();

    expect(mockState.calls.logout).toBe(1);
    expect(mockState.calls.closeSession).toBe(1);
    expect(mockState.calls.finalize).toBe(1);
    expect(await signer.hasKey('rOne')).toBe(false);
  });
});

// ── Pure helper tests ───────────────────────────────────────────────────────
// These exercise the crypto glue independently of the HSM lifecycle.

describe('compressSecp256k1Pubkey', () => {
  it('compresses the secp256k1 generator point (G, even Y → 0x02 prefix)', () => {
    // Generator G. Y last byte = 0xB8 (even) → prefix should be 0x02.
    const wrapped = Buffer.from(
      '0441' +
        '04' +
        '79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798' +
        '483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8',
      'hex',
    );
    const compressed = compressSecp256k1Pubkey(wrapped);
    expect(compressed.length).toBe(33);
    expect(compressed[0]).toBe(0x02);
    // Compressed G's X coordinate is the canonical secp256k1 generator X.
    expect(compressed.subarray(1).toString('hex').toUpperCase()).toBe(
      '79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798',
    );
  });

  it('compresses a synthetic point with even Y → 0x02 prefix', () => {
    // Construct a point where Y's last byte is clearly even (0xAA).
    const x = Buffer.alloc(32, 0x11);
    const y = Buffer.concat([Buffer.alloc(31, 0x22), Buffer.from([0xaa])]);
    const raw = Buffer.concat([Buffer.from([0x04]), x, y]);
    const wrapped = Buffer.concat([Buffer.from([0x04, 0x41]), raw]);
    const compressed = compressSecp256k1Pubkey(wrapped);
    expect(compressed.length).toBe(33);
    expect(compressed[0]).toBe(0x02);
    expect(compressed.subarray(1)).toEqual(x);
  });

  it('compresses a wrapped uncompressed point (odd Y → 0x03 prefix)', () => {
    const x = Buffer.alloc(32, 0x11);
    const y = Buffer.concat([Buffer.alloc(31, 0x22), Buffer.from([0xab])]); // odd
    const raw = Buffer.concat([Buffer.from([0x04]), x, y]);
    const wrapped = Buffer.concat([Buffer.from([0x04, 0x41]), raw]);
    const compressed = compressSecp256k1Pubkey(wrapped);
    expect(compressed[0]).toBe(0x03);
  });

  it('throws on malformed EC point', () => {
    expect(() => compressSecp256k1Pubkey(Buffer.from('deadbeef', 'hex'))).toThrow();
  });
});

describe('rawEcdsaToDer', () => {
  it('encodes low-S signature without modification', () => {
    // r and s chosen small + leading-high-bit-unset so no pad.
    const r = Buffer.from('11'.repeat(32), 'hex');
    const s = Buffer.from('22'.repeat(32), 'hex');
    const raw = Buffer.concat([r, s]);
    const der = rawEcdsaToDer(raw);
    // Shape: 30 <total> 02 <rlen> <r> 02 <slen> <s>
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
  });

  it('normalizes high-S to low-S (malleability fix)', () => {
    // Any s > n/2 should be replaced by n - s. Use s = n - 1 which is
    // clearly > n/2, expect output s = 1.
    const r = Buffer.from('11'.repeat(32), 'hex');
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const sHigh = n - 1n;
    const sHex = sHigh.toString(16).padStart(64, '0');
    const raw = Buffer.concat([r, Buffer.from(sHex, 'hex')]);
    const der = rawEcdsaToDer(raw);
    // Find the second INTEGER tag (s).
    const rLen = der[3] ?? 0;
    const sTagOffset = 4 + rLen;
    expect(der[sTagOffset]).toBe(0x02);
    const sLen = der[sTagOffset + 1];
    const sBytes = der.subarray(sTagOffset + 2, sTagOffset + 2 + (sLen ?? 0));
    expect(BigInt(`0x${sBytes.toString('hex')}`)).toBe(1n);
  });

  it('prepends 0x00 when r has the high bit set (DER positive-integer rule)', () => {
    // r = 0x80...; high bit set → must be padded to avoid being misread as negative.
    const r = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0x00)]);
    const s = Buffer.from('11'.repeat(32), 'hex');
    const raw = Buffer.concat([r, s]);
    const der = rawEcdsaToDer(raw);
    // First INTEGER should be 0x02 <33> 0x00 0x80 0x00…
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33); // 32 bytes + 1 pad
    expect(der[4]).toBe(0x00);
    expect(der[5]).toBe(0x80);
  });

  it('throws on non-64-byte input', () => {
    expect(() => rawEcdsaToDer(Buffer.alloc(63))).toThrow();
  });
});
