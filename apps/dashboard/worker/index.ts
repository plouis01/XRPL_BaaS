// Cloudflare Worker for the RailForge dashboard.
//
// Two responsibilities:
//
//   1. Proxy /v1/* and /health to the Fly-hosted RailForge API. This makes
//      the dashboard and API appear same-origin to the browser (both on
//      `*.workers.dev` from the browser's POV), which is what makes the
//      httpOnly session cookie work end-to-end. Without this, the cookie
//      is cross-site (`*.workers.dev` ↔ `*.fly.dev`, both on the Public
//      Suffix List), and modern browsers reject third-party cookies even
//      when SameSite=None+Secure is set — Safari ITP, Firefox Total
//      Cookie Protection, and Chrome's tracking protection in default
//      settings all break the auth flow.
//
//   2. Serve the React SPA from the static-assets binding. Bound as ASSETS
//      in wrangler.jsonc. SPA fallback (`not_found_handling: single-page-
//      application`) means unknown paths return /index.html so React
//      Router's client-side routes resolve.
//
// Why this is also better than the cookie-only fix:
//   - Set-Cookie returned by the API is stored by the browser against the
//     dashboard origin (because the response visibly comes from there),
//     so it's a first-party cookie. We can flip the cookie back to
//     SameSite=Strict in dashboardSession.ts and recover the CSRF
//     defense-in-depth that we lost when we relaxed to None.
//   - The browser never makes a CORS-preflighted request — same-origin —
//     so we shave a round-trip on every state-changing call.
//   - The Worker is the single egress point to the API, which is a
//     natural place to add per-tenant rate-limit hooks later.

const UPSTREAM = 'https://railforge-api.fly.dev';

interface Env {
  // Bound by `assets.binding: "ASSETS"` in wrangler.jsonc. Calling
  // env.ASSETS.fetch(request) defers to Cloudflare's static-asset server,
  // which honors the SPA fallback configured alongside the binding.
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API surface — proxy to the Fly upstream. /health is the public probe
    // endpoint used by uptime checks; everything authenticated lives under
    // /v1/. Anything else is a static asset.
    if (url.pathname.startsWith('/v1/') || url.pathname === '/health') {
      const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;
      // `new Request(url, init)` with `init` being the original Request
      // copies method, headers, body, redirect, etc. — the cleanest way to
      // forward without manually wiring each field. The body remains a
      // ReadableStream so it streams up to Fly without buffering.
      const upstreamRequest = new Request(upstreamUrl, request);
      return fetch(upstreamRequest);
    }

    // Static SPA — index.html, JS bundle, assets, plus SPA fallback for
    // client-side routes like /quickstart, /agents, etc.
    return env.ASSETS.fetch(request);
  },
};
