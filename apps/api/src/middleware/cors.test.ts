import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('CORS middleware', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('sets Access-Control-Allow-Origin to DASHBOARD_ORIGIN', async () => {
    process.env.DASHBOARD_ORIGIN = 'https://dashboard.railforge.dev';
    process.env.NODE_ENV = 'test';
    const { corsMiddleware } = await import('./cors.ts');
    const app = new Hono();
    app.use('*', corsMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Origin: 'https://dashboard.railforge.dev' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dashboard.railforge.dev');
  });

  it('defaults to localhost:5173 when DASHBOARD_ORIGIN is unset', async () => {
    // biome-ignore lint/performance/noDelete: env var must be removed, not set to "undefined"
    delete process.env.DASHBOARD_ORIGIN;
    process.env.NODE_ENV = 'test';
    const { corsMiddleware } = await import('./cors.ts');
    const app = new Hono();
    app.use('*', corsMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('throws in production when DASHBOARD_ORIGIN is unset', async () => {
    // biome-ignore lint/performance/noDelete: env var must be removed, not set to "undefined"
    delete process.env.DASHBOARD_ORIGIN;
    process.env.NODE_ENV = 'production';
    await expect(import('./cors.ts')).rejects.toThrow('DASHBOARD_ORIGIN must be set in production');
  });

  it('echoes the matching origin when DASHBOARD_ORIGIN is a comma-separated list', async () => {
    process.env.DASHBOARD_ORIGIN =
      'https://dashboard.railforge.dev, https://railforge-dashboard.pages.dev';
    process.env.NODE_ENV = 'test';
    const { corsMiddleware } = await import('./cors.ts');
    const app = new Hono();
    app.use('*', corsMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    for (const origin of [
      'https://dashboard.railforge.dev',
      'https://railforge-dashboard.pages.dev',
    ]) {
      const res = await app.request('/test', { headers: { Origin: origin } });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('rejects an origin not in the DASHBOARD_ORIGIN list', async () => {
    process.env.DASHBOARD_ORIGIN = 'https://dashboard.railforge.dev';
    process.env.NODE_ENV = 'test';
    const { corsMiddleware } = await import('./cors.ts');
    const app = new Hono();
    app.use('*', corsMiddleware);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('responds to OPTIONS preflight with allowed methods', async () => {
    process.env.DASHBOARD_ORIGIN = 'https://dash.test';
    process.env.NODE_ENV = 'test';
    const { corsMiddleware } = await import('./cors.ts');
    const app = new Hono();
    app.use('*', corsMiddleware);
    app.post('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dash.test',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const allow = res.headers.get('access-control-allow-methods');
    expect(allow).toContain('POST');
    expect(allow).toContain('DELETE');
  });
});
