import type { MiddlewareHandler } from "hono";

// Idempotency key handling. State-changing endpoints (POST/PUT/DELETE) MUST
// receive an Idempotency-Key header. The key is stored in transactions table
// with UNIQUE(client_id, idempotency_key); duplicate requests return the cached
// response. See PLAN.md §3.7.
// TODO Sprint 1: implement.
export const idempotency: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    const key = c.req.header("idempotency-key");
    if (!key) {
      return c.json({ error: "Missing Idempotency-Key header" }, 400);
    }
  }
  await next();
  return;
};
