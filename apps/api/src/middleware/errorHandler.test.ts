import { describe, expect, it, vi } from 'vitest';

const loggerErrorMock = vi.fn();
vi.mock('../logger.ts', () => ({
  logger: { error: loggerErrorMock, warn: vi.fn(), info: vi.fn() },
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

  it('surfaces the pg cause fields when Drizzle wraps a DB error', () => {
    // Drizzle wraps every db error in:
    //   new Error(`Failed query: ${sql}\nparams: ${...}`)
    // and sets `.cause = pgError` carrying the actually-useful .code /
    // .detail / .constraint. The wrapper hides the discriminator unless
    // the error handler unwraps cause explicitly.
    loggerErrorMock.mockReset();
    const pgError = Object.assign(new Error('column "amount_usd_cents" does not exist'), {
      code: '42703',
      column: 'amount_usd_cents',
      table: 'transactions',
    });
    const wrapped = new Error('Failed query: insert into transactions … returning id');
    (wrapped as { cause?: unknown }).cause = pgError;

    const { c } = makeContext();
    errorHandler(wrapped, c);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logCtx, logMsg] = loggerErrorMock.mock.calls[0]!;
    expect(logMsg).toBe('API error (DB-layer)');
    expect(logCtx).toMatchObject({
      pg: {
        pgCode: '42703',
        pgColumn: 'amount_usd_cents',
        pgTable: 'transactions',
      },
    });
  });

  it('does NOT add a pg field for non-DB errors', () => {
    loggerErrorMock.mockReset();
    const { c } = makeContext();
    errorHandler(new Error('regular service error'), c);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [logCtx, logMsg] = loggerErrorMock.mock.calls[0]!;
    expect(logMsg).toBe('API error');
    expect(logCtx).not.toHaveProperty('pg');
  });
});
