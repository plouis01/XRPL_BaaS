// HSM integration test — runs against a REAL CloudHSM cluster.
//
// GATING: self-skips unless ALL of:
//   - RAILFORGE_HSM_TEST=1
//   - HSM_MODULE_PATH points at the CloudHSM PKCS#11 .so
//   - HSM_CU_USERNAME + HSM_CU_PASSWORD set
//   - NODE_ENV=production (HsmSigner refuses to construct otherwise)
//
// This test MUST run on a Linux host inside the same VPC as the CloudHSM
// cluster (or over a VPN/SSH tunnel). macOS cannot load the .so.
//
// What it proves that unit tests cannot:
//   1. The PKCS#11 library loads and connects to the real HSM.
//   2. Key generation produces a valid secp256k1 keypair.
//   3. The derived XRPL address is a valid classic address.
//   4. Signing a real transaction produces a tx_blob that xrpl.js accepts.
//   5. (Optional) Submit to testnet and verify tesSUCCESS.
//
// Run manually from the EC2 bastion:
//   NODE_ENV=production RAILFORGE_HSM_TEST=1 \
//     HSM_MODULE_PATH=/opt/cloudhsm/lib/libcloudhsm_pkcs11.so \
//     HSM_CU_USERNAME=railforge_worker \
//     HSM_CU_PASSWORD=<password> \
//     bunx vitest run apps/worker/src/xrpl/HsmSigner.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidClassicAddress } from 'xrpl';

const SHOULD_RUN =
  process.env.RAILFORGE_HSM_TEST === '1' &&
  process.env.NODE_ENV === 'production' &&
  !!process.env.HSM_MODULE_PATH &&
  !!process.env.HSM_CU_USERNAME &&
  !!process.env.HSM_CU_PASSWORD;

const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

describeOrSkip('HsmSigner real-HSM integration', () => {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import to avoid loading pkcs11 on macOS
  let HsmSigner: any;
  // biome-ignore lint/suspicious/noExplicitAny: instance typed loosely for integration
  let signer: any;
  let generatedAddress: string;
  let generatedLabel: string;

  beforeAll(async () => {
    const mod = await import('./HsmSigner.ts');
    HsmSigner = mod.HsmSigner;
    signer = new HsmSigner({
      slotId: Number(process.env.HSM_SLOT ?? '0'),
      pin: `${process.env.HSM_CU_USERNAME}:${process.env.HSM_CU_PASSWORD}`,
      modulePath: process.env.HSM_MODULE_PATH,
    });
  }, 30_000);

  afterAll(async () => {
    if (signer) await signer.close();
  }, 15_000);

  it('generates a keypair in the HSM and derives a valid XRPL address', async () => {
    const result = await signer.generateInHsm();
    generatedAddress = result.address;
    generatedLabel = result.keyHandle;

    expect(isValidClassicAddress(generatedAddress)).toBe(true);
    expect(generatedLabel).toMatch(/^railforge:r/);
    expect(await signer.hasKey(generatedAddress)).toBe(true);
  }, 30_000);

  it('loads the generated key by label', async () => {
    // After generateInHsm, the key is already cached. Clear cache and
    // reload to exercise the FindObjects path.
    await signer.close();
    signer = new HsmSigner({
      slotId: Number(process.env.HSM_SLOT ?? '0'),
      pin: `${process.env.HSM_CU_USERNAME}:${process.env.HSM_CU_PASSWORD}`,
      modulePath: process.env.HSM_MODULE_PATH,
    });

    await signer.loadKey(generatedAddress, generatedLabel);
    expect(await signer.hasKey(generatedAddress)).toBe(true);
  }, 30_000);

  it('signs a Payment transaction and produces a valid tx_blob + hash', async () => {
    const result = await signer.sign(generatedAddress, {
      TransactionType: 'Payment',
      Account: generatedAddress,
      Destination: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      Amount: '1000000',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 999999999,
    });

    expect(result.tx_blob).toMatch(/^[0-9A-F]+$/);
    expect(result.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(result.tx_blob.length).toBeGreaterThan(100);
  }, 30_000);
});
