import { Hono } from "hono";

// Webhook subscription routes (endpoint registration, secret rotation).
// Delivery itself happens in apps/worker. See PLAN.md §4.4 / ARCHITECTURE.md §4.9.
// TODO Sprint 3.

const webhooks = new Hono();

webhooks.post("/", (c) => c.json({ error: "not implemented" }, 501));
webhooks.get("/", (c) => c.json({ error: "not implemented" }, 501));
webhooks.delete("/:id", (c) => c.json({ error: "not implemented" }, 501));

export default webhooks;
