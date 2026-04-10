import { afterEach, describe, expect, it } from 'vitest';
import { SignerError } from './signer.ts';

// HsmSigner refuses to construct outside production. We temporarily set
// NODE_ENV to test the constructor guard AND the happy path.

describe('HsmSigner', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('throws when constructed outside production', async () => {
    process.env.NODE_ENV = 'development';
    const { HsmSigner } = await import('./HsmSigner.ts');
    expect(() => new HsmSigner({ slotId: 0, pin: 'test', modulePath: '/dev/null' })).toThrow(
      'production-only',
    );
  });

  it('constructs in production environment', async () => {
    process.env.NODE_ENV = 'production';
    // Dynamic import to get a fresh module evaluation with NODE_ENV=production.
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });
    expect(signer).toBeDefined();
    // Clean up
    await signer.close();
  });

  it('loadKey stores handle and hasKey returns true', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });

    await signer.loadKey('rTestAddress123456789012345', 'hsm-handle-abc');
    expect(await signer.hasKey('rTestAddress123456789012345')).toBe(true);
    expect(await signer.hasKey('rOtherAddress')).toBe(false);

    await signer.close();
  });

  it('loadKey rejects empty ref', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });

    await expect(signer.loadKey('rAddr', '')).rejects.toThrow(SignerError);

    await signer.close();
  });

  it('loadKey is a no-op when address already loaded', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });

    await signer.loadKey('rAddr', 'handle-1');
    await signer.loadKey('rAddr', 'handle-1'); // no-op
    expect(await signer.hasKey('rAddr')).toBe(true);

    await signer.close();
  });

  it('sign throws SignerError (PKCS#11 not wired)', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });

    await signer.loadKey('rAddr', 'handle-1');
    // Any sign attempt fails — either at serialization (incomplete tx) or
    // at the PKCS#11 boundary (not wired). Both produce a SignerError.
    await expect(
      signer.sign('rAddr', {
        TransactionType: 'Payment',
        Account: 'rAddr',
      } as any),
    ).rejects.toThrow(SignerError);

    await signer.close();
  });

  it('sign throws no_key when address not loaded', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });

    await expect(
      signer.sign('rUnknown', {
        TransactionType: 'Payment',
        Account: 'rUnknown',
      } as any),
    ).rejects.toThrow(SignerError);

    await signer.close();
  });

  it('close clears all key handles', async () => {
    process.env.NODE_ENV = 'production';
    const mod = await import('./HsmSigner.ts');
    const signer = new mod.HsmSigner({
      slotId: 0,
      pin: 'test',
      modulePath: '/dev/null',
    });

    await signer.loadKey('rAddr', 'handle-1');
    expect(await signer.hasKey('rAddr')).toBe(true);
    await signer.close();
    expect(await signer.hasKey('rAddr')).toBe(false);
  });
});
