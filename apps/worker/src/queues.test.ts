// Tests for the HSM Phase 3 guard: mainnet boots MUST use an HSM-backed
// signer, never DevSigner. Enforced in two places: `assertMainnetHsmInvariant`
// fires at process start, and `getSigner` re-checks at selection time so an
// API path can't trigger a soft fallback later.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertMainnetHsmInvariant, disconnectWorker, getSigner } from './queues.ts';

// Mock HsmSigner since it would try to dlopen the CloudHSM PKCS#11 lib
// on import and fail on dev machines. The guard paths don't exercise
// the real binding.
vi.mock('./xrpl/HsmSigner.ts', () => ({
  // Constructor accepts any args at runtime but we don't exercise them.
  HsmSigner: class {},
}));

const ORIGINAL_ENV = { ...process.env };

// Replace process.env with a clean copy that omits both guard-relevant vars.
// Using assignment (not `delete`) keeps biome's noDelete rule happy while
// still producing the "var not set" behavior: the fresh object simply has
// no key for HSM_PROVIDER / XRPL_NETWORK.
function freshEnv(overrides: Record<string, string>): void {
  const base: NodeJS.ProcessEnv = { ...ORIGINAL_ENV };
  base.HSM_PROVIDER = undefined;
  base.XRPL_NETWORK = undefined;
  process.env = { ...base, ...overrides } as NodeJS.ProcessEnv;
}

beforeEach(async () => {
  // Reset the module-level signer singleton between tests.
  await disconnectWorker();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('assertMainnetHsmInvariant', () => {
  it('passes on testnet (default)', () => {
    freshEnv({ XRPL_NETWORK: 'testnet' });
    expect(() => assertMainnetHsmInvariant()).not.toThrow();
  });

  it('passes on mainnet with HSM_PROVIDER=aws_cloudhsm', () => {
    freshEnv({ XRPL_NETWORK: 'mainnet', HSM_PROVIDER: 'aws_cloudhsm' });
    expect(() => assertMainnetHsmInvariant()).not.toThrow();
  });

  it('throws on mainnet without HSM_PROVIDER', () => {
    freshEnv({ XRPL_NETWORK: 'mainnet' });
    expect(() => assertMainnetHsmInvariant()).toThrow(/mainnet/i);
  });

  it('throws on mainnet with a non-HSM provider', () => {
    freshEnv({ XRPL_NETWORK: 'mainnet', HSM_PROVIDER: 'softhsm' });
    expect(() => assertMainnetHsmInvariant()).toThrow(/HSM_PROVIDER=aws_cloudhsm/);
  });
});

describe('getSigner — mainnet guard', () => {
  it('refuses DevSigner on mainnet', () => {
    freshEnv({ XRPL_NETWORK: 'mainnet' });
    expect(() => getSigner()).toThrow(/refusing to sign mainnet/);
  });

  it('allows DevSigner on testnet', () => {
    freshEnv({ XRPL_NETWORK: 'testnet' });
    const s = getSigner();
    expect(s).toBeDefined();
  });
});
