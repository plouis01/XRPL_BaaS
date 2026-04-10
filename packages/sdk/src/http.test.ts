import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, RailForgeError } from './http.ts';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('HttpClient', () => {
  let http: HttpClient;

  beforeEach(() => {
    http = new HttpClient({
      baseUrl: 'https://api.example.com/',
      apiKey: 'rf_test_abc',
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips trailing slash from base URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: '1' }),
    });

    await http.get('/v1/accounts/rAddr');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/accounts/rAddr',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends X-Api-Key header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await http.get('/v1/test');

    const headers = mockFetch.mock.calls[0]![1].headers;
    expect(headers['X-Api-Key']).toBe('rf_test_abc');
  });

  it('sends Idempotency-Key on POST', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ id: '1' }),
    });

    await http.post('/v1/accounts', { label: 'test' });

    const headers = mockFetch.mock.calls[0]![1].headers;
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not send Idempotency-Key on GET', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await http.get('/v1/test');

    const headers = mockFetch.mock.calls[0]![1].headers;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('returns null for 204 No Content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
    });

    const result = await http.delete('/v1/webhooks/endpoints/123');
    expect(result).toBeNull();
  });

  it('throws RailForgeError on 4xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Payment not found' }),
    });

    await expect(http.get('/v1/payments/missing')).rejects.toThrow(RailForgeError);

    try {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_input' }),
      });
      await http.post('/v1/accounts', {});
    } catch (err) {
      const re = err as RailForgeError;
      expect(re.status).toBe(400);
      expect(re.body?.error).toBe('invalid_input');
    }
  });

  it('sends JSON body on PUT', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ tx_id: 'abc', status: 'queued' }),
    });

    await http.put('/v1/tokens/123/freeze', { unfreeze: true });

    const call = mockFetch.mock.calls[0]!;
    expect(call[1].method).toBe('PUT');
    expect(JSON.parse(call[1].body)).toEqual({ unfreeze: true });
  });

  it('sends body on DELETE when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ tx_id: 'abc', status: 'queued' }),
    });

    await http.delete('/v1/accounts/rAddr', { destination: 'rDest' });

    const call = mockFetch.mock.calls[0]!;
    expect(call[1].method).toBe('DELETE');
    expect(JSON.parse(call[1].body)).toEqual({ destination: 'rDest' });
  });
});
