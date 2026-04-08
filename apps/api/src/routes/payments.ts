import { Hono } from "hono";

// Payment service routes. See PLAN.md §4.6 / ARCHITECTURE.md §4.6.
// XRP and token payments, escrows, batch (XLS-56 V1.1 pending).
// All payments are idempotent — middleware enforces the Idempotency-Key header.
// TODO Sprint 3.

const payments = new Hono();

payments.post("/", (c) => c.json({ error: "not implemented" }, 501));
payments.post("/batch", (c) => c.json({ error: "not implemented" }, 501));
payments.get("/:id", (c) => c.json({ error: "not implemented" }, 501));
payments.post("/escrows", (c) => c.json({ error: "not implemented" }, 501));
payments.post("/escrows/:id/finish", (c) =>
  c.json({ error: "not implemented" }, 501),
);
payments.post("/escrows/:id/cancel", (c) =>
  c.json({ error: "not implemented" }, 501),
);

export default payments;
