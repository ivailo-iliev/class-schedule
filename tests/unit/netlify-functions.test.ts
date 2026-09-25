import { describe, expect, test, vi } from 'vitest';

const handleAccessRequest = vi.hoisted(() => vi.fn());
vi.mock('../../netlify/lib/access.mjs', () => ({ handleAccessRequest }));

import accessFunction, { config as accessConfig } from '../../netlify/functions/access.mjs';

const statuses = [200, 400, 401, 403, 429, 503];

function result(status: number) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-test': 'boundary' },
    body: JSON.stringify({ status }),
  };
}

describe('Netlify function boundaries', () => {
  test.each(statuses)('access returns a web Response for status %i', async (status) => {
    handleAccessRequest.mockResolvedValueOnce(result(status));

    const response = await accessFunction(
      new Request('https://class-admin.netlify.app/api/access', {
        method: 'POST',
        body: '{}',
      }),
      {},
    );

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(status);
    expect(response.headers.get('x-test')).toBe('boundary');
    expect(await response.json()).toEqual({ status });
  });

  test('uses the default access endpoint behind the public route redirect', async () => {
    handleAccessRequest.mockResolvedValueOnce(result(400));
    await accessFunction(
      new Request('https://class-admin.netlify.app/api/access', {
        method: 'POST',
        headers: { 'x-nf-client-connection-ip': '198.51.100.10' },
        body: '{"token":"x"}',
      }),
      {},
    );
    expect(accessConfig).toEqual({
      rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
    });
    expect(handleAccessRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'POST',
      body: '{"token":"x"}',
      clientIp: '198.51.100.10',
    }));
  });
});
