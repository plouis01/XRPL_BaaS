import { Hono } from "hono";

// Permission service routes. See PLAN.md §4.4 / ARCHITECTURE.md §4.4.
// XLS-75 V1.1 pending. Pre-V1.1 fallback: multi-sign with role-specific signer lists.
// TODO Sprint 6.

const permissions = new Hono();

permissions.post("/", (c) => c.json({ error: "not implemented" }, 501));
permissions.get("/:delegator", (c) =>
  c.json({ error: "not implemented" }, 501),
);
permissions.delete("/:delegator/:delegate", (c) =>
  c.json({ error: "not implemented" }, 501),
);
permissions.get("/audit/:delegator", (c) =>
  c.json({ error: "not implemented" }, 501),
);

export default permissions;
