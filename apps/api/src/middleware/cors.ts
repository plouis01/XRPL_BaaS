import { cors } from 'hono/cors';

// CORS middleware — restricts browser requests to the dashboard origin(s).
//
// DASHBOARD_ORIGIN supports a single origin OR a comma-separated list, e.g.
//   DASHBOARD_ORIGIN=https://dashboard.railforge.dev,https://railforge-dashboard.pages.dev
// The list form is needed when the production custom domain coexists with a
// Cloudflare Pages preview URL during cutover.
//
// In production, DASHBOARD_ORIGIN must be explicitly set — falling back to
// localhost would silently allow any local dev server to make credentialed
// cross-origin requests against a production API.

if (process.env.NODE_ENV === 'production' && !process.env.DASHBOARD_ORIGIN) {
  throw new Error(
    'DASHBOARD_ORIGIN must be set in production (e.g. https://dashboard.railforge.dev)',
  );
}

const allowedOrigins = (process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

export const corsMiddleware = cors({
  origin: allowedOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Api-Key'],
  exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86400,
  credentials: true,
});
