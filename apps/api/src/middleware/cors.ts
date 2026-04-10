import { cors } from 'hono/cors';

// CORS middleware — restricts browser requests to the dashboard origin.
// Security backlog item #13.
//
// DASHBOARD_ORIGIN env var controls the allowed origin.
// Defaults to localhost:5173 (Vite dev server) when unset.
// In production, set to the real dashboard URL (e.g. https://dashboard.railforge.dev).

const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173';

export const corsMiddleware = cors({
  origin: dashboardOrigin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Api-Key'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400,
  credentials: true,
});
