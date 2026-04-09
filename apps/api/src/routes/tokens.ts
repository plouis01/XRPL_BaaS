// Token service routes.
//
// POST   /v1/tokens              → create (MPT default, trustline opt-in)
// GET    /v1/tokens/:id          → TODO later this sprint
// POST   /v1/tokens/:id/transfer → TODO later this sprint
// PUT    /v1/tokens/:id/freeze   → TODO later this sprint
// PUT    /v1/tokens/:id/clawback → TODO later this sprint

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { TokenServiceError, createToken } from "../services/token.service.ts";
import type { AppEnv } from "../types.ts";
import { createTokenSchema } from "../validators/schemas.ts";

const tokens = new Hono<AppEnv>();

tokens.post("/", zValidator("json", createTokenSchema), async (c) => {
  const clientId = c.get("clientId");
  const body = c.req.valid("json");

  try {
    const token = await createToken({
      clientId,
      issuer: body.issuer,
      type: body.type,
      currencyCode: body.currency_code,
      transferFee: body.transfer_fee,
      clawback: body.clawback,
      freezeEnabled: body.freeze_enabled,
      maxSupply: body.max_supply,
      metadata: body.metadata,
    });

    return c.json(
      {
        id: token.id,
        issuer_address: token.issuerAddress,
        token_type: token.tokenType,
        currency_code: token.currencyCode,
        mpt_issuance_id: token.mptIssuanceId,
        transfer_fee: token.transferFee,
        clawback: token.clawback,
        freeze_enabled: token.freezeEnabled,
        max_supply: token.maxSupply,
        status: token.status,
        tx_id: token.txId,
        created_at: token.createdAt,
      },
      202, // 202 Accepted — tx is queued, not yet validated on-ledger
    );
  } catch (err) {
    if (err instanceof TokenServiceError) {
      if (err.code === "issuer_not_found") {
        return c.json({ error: "Issuer account not found" }, 404);
      }
      if (err.code === "trustline_not_supported_yet") {
        return c.json({ error: err.message }, 501);
      }
      if (err.code === "invalid_input") {
        return c.json({ error: err.message }, 400);
      }
    }
    throw err;
  }
});

// TODO Sprint 2 follow-ups
tokens.get("/:id", (c) => c.json({ error: "not implemented" }, 501));
tokens.post("/:id/transfer", (c) => c.json({ error: "not implemented" }, 501));
tokens.put("/:id/freeze", (c) => c.json({ error: "not implemented" }, 501));
tokens.put("/:id/clawback", (c) => c.json({ error: "not implemented" }, 501));

export default tokens;
