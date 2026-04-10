import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { errorHandler } = await import('./errorHandler.ts');

function makeContext() {
  const jsonFn = vi.fn((_body: unknown, _status: number) => new Response());
  return {
    json: jsonFn,
    c: { json: jsonFn } as unknown as Parameters<typeof errorHandler>[1],
  };
}

describe('errorHandler', () => {
  it('returns 500 with error message in development', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const { c, json } = makeContext();
    errorHandler(new Error('db connection failed'), c);
    expect(json).toHaveBeenCalledWith({ error: 'db connection failed' }, 500);
    process.env.NODE_ENV = original;
  });

  it('hides error details in production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { c, json } = makeContext();
    errorHandler(new Error('relation "secrets" does not exist'), c);
    expect(json).toHaveBeenCalledWith({ error: 'Internal server error' }, 500);
    process.env.NODE_ENV = original;
  });

  it('returns generic message when error has no message', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const { c, json } = makeContext();
    errorHandler(new Error(''), c);
    expect(json).toHaveBeenCalledWith({ error: 'Internal server error' }, 500);
    process.env.NODE_ENV = original;
  });
});
