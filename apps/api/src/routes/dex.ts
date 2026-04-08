import { Hono } from "hono";

// DEX service routes. See PLAN.md §4.8 / ARCHITECTURE.md §4.8.
// OfferCreate, OfferCancel, AMMDeposit, AMMWithdraw, Permissioned DEX (XLS-81).
// TODO Sprint 6.

const dex = new Hono();

dex.post("/offers", (c) => c.json({ error: "not implemented" }, 501));
dex.delete("/offers/:id", (c) => c.json({ error: "not implemented" }, 501));
dex.get("/orderbook/:base/:counter", (c) =>
  c.json({ error: "not implemented" }, 501),
);
dex.post("/amm/deposit", (c) => c.json({ error: "not implemented" }, 501));
dex.post("/amm/withdraw", (c) => c.json({ error: "not implemented" }, 501));
dex.get("/amm/:asset1/:asset2", (c) =>
  c.json({ error: "not implemented" }, 501),
);

export default dex;
