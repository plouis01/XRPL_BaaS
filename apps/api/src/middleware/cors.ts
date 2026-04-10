import { cors } from 'hono/cors';

// CORS middleware — restricts browser requests to the dashboard origin.
//
// DASHBOARD_ORIGIN env var controls the allowed origin.
// In production, DASHBOARD_ORIGIN must be explicitly set — falling back to
// localhost would silently allow any local dev server to make credentialed
// cross-origin requests against a production API.

if (process.env.NODE_ENV === 'production' && !process.env.DASHBOARD_ORIGIN) {
  throw new Error(
    'DASHBOARD_ORIGIN must be set in production (e.g. https://dashboard.railforge.dev)',
  );
}

const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173';

export const corsMiddleware = cors({
  origin: dashboardOrigin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Api-Key'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400,
  credentials: true,
});
