import { Hono } from "hono";
import { logger } from "./logger.ts";
import { errorHandler } from "./middleware/errorHandler.ts";
import { auth } from "./middleware/auth.ts";
import { rateLimit } from "./middleware/rateLimit.ts";
import { idempotency } from "./middleware/idempotency.ts";
import accountsRoute from "./routes/accounts.ts";
import tokensRoute from "./routes/tokens.ts";
import credentialsRoute from "./routes/credentials.ts";
import permissionsRoute from "./routes/permissions.ts";
import domainsRoute from "./routes/domains.ts";
import paymentsRoute from "./routes/payments.ts";
import dexRoute from "./routes/dex.ts";
import webhooksRoute from "./routes/webhooks.ts";
import type { AppEnv } from "./types.ts";

const app = new Hono<AppEnv>();

app.onError(errorHandler);

// Public health check
app.get("/health", (c) => c.json({ status: "ok" }));

// All /v1/* routes are authenticated, rate-limited, and idempotency-aware.
const v1 = new Hono<AppEnv>();
v1.use("*", auth);
v1.use("*", rateLimit);
v1.use("*", idempotency);

v1.route("/accounts", accountsRoute);
v1.route("/tokens", tokensRoute);
v1.route("/credentials", credentialsRoute);
v1.route("/permissions", permissionsRoute);
v1.route("/domains", domainsRoute);
v1.route("/payments", paymentsRoute);
v1.route("/dex", dexRoute);
v1.route("/webhooks", webhooksRoute);

app.route("/v1", v1);

const port = Number(process.env.API_PORT ?? 3000);
logger.info({ port }, "RailForge API starting");

export default {
  port,
  fetch: app.fetch,
};
