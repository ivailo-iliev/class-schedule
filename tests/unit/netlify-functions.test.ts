import { describe, expect, test, vi } from 'vitest';

const handleAccessRequest = vi.hoisted(() => vi.fn());
const handleManifestRequest = vi.hoisted(() => vi.fn());

vi.mock('../../netlify/lib/access.mjs', () => ({ handleAccessRequest }));
vi.mock('../../netlify/lib/manifest.mjs', () => ({ handleManifestRequest }));

import accessFunction, { config as accessConfig } from '../../netlify/functions/access.mjs';
import manifestFunction, { config as manifestConfig } from '../../netlify/functions/manifest.mjs';

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

  test.each(statuses)('manifest returns a web Response for status %i', async (status) => {
    handleManifestRequest.mockResolvedValueOnce(result(status));

    const response = await manifestFunction(
      new Request('https://class-admin.netlify.app/manifest.webmanifest?profile=profile'),
      {},
    );

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(status);
    expect(response.headers.get('x-test')).toBe('boundary');
    expect(await response.json()).toEqual({ status });
  });

  test('uses modern function configs and translates request fields', async () => {
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
      path: '/api/access',
      rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
    });
    expect(handleAccessRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'POST',
      body: '{"token":"x"}',
      clientIp: '198.51.100.10',
    }));

    handleManifestRequest.mockResolvedValueOnce(result(400));
    await manifestFunction(
      new Request('https://class-admin.netlify.app/manifest.webmanifest?profile=profile'),
      {},
    );
    expect(manifestConfig).toEqual({
      path: '/manifest.webmanifest',
      rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
    });
    expect(handleManifestRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'GET',
      queryStringParameters: { profile: 'profile' },
    }));
  });
});
