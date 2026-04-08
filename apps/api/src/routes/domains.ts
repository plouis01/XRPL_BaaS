import { Hono } from "hono";

// Domain service routes. See PLAN.md §4.5 / ARCHITECTURE.md §4.5.
// XLS-80 (Permissioned Domains).
// TODO Sprint 5.

const domains = new Hono();

domains.post("/", (c) => c.json({ error: "not implemented" }, 501));
domains.put("/:id", (c) => c.json({ error: "not implemented" }, 501));
domains.delete("/:id", (c) => c.json({ error: "not implemented" }, 501));
domains.get("/:id/members", (c) => c.json({ error: "not implemented" }, 501));
domains.post("/:id/check", (c) => c.json({ error: "not implemented" }, 501));

export default domains;
