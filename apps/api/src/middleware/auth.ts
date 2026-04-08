import type { MiddlewareHandler } from "hono";

// API key validation. Looks up the SHA-256 hash in the api_keys table,
// loads the client, and stashes clientId on the context.
// TODO Sprint 1: implement against packages/db.
export const auth: MiddlewareHandler = async (c, next) => {
  const apiKey = c.req.header("x-api-key");
  if (!apiKey) {
    return c.json({ error: "Missing API key" }, 401);
  }
  // c.set('clientId', clientId);
  await next();
};
