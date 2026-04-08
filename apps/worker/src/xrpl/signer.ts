// HSM-backed transaction signer. Master keys never leave the HSM boundary.
// In dev, backed by SoftHSM; in prod, by AWS CloudHSM.
// See SETUP.md §5 CLAUDE.md implementation rules — never log signed blobs.
// TODO Sprint 1: implement.

export interface SignedTransaction {
  tx_blob: string;
  hash: string;
}

export interface Signer {
  sign(
    address: string,
    txJson: Record<string, unknown>,
  ): Promise<SignedTransaction>;
}
