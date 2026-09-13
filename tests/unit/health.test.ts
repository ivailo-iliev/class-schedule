import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import handleHealthRequest from '../../netlify/lib/health.mjs';
import healthFunction, { config as healthConfig } from '../../netlify/functions/health.mjs';

const root = resolve(import.meta.dirname, '../..');
const netlify = readFileSync(resolve(root, 'netlify.toml'), 'utf8');

async function request(method: string) {
  return handleHealthRequest(new Request('https://class-admin.netlify.app/api/health', { method }));
}

describe('public health endpoint', () => {
  test('returns an ok JSON response for GET without external dependencies', async () => {
    const response = await request('GET');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  test('accepts HEAD with the same health status and headers', async () => {
    const response = await request('HEAD');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('rejects methods other than GET and HEAD', async () => {
    const response = await request('POST');

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' });
  });

  test('exports the modern Netlify handler with an explicit path', async () => {
    const response = await healthFunction(new Request('https://class-admin.netlify.app/api/health'), {});

    expect(healthConfig).toEqual({ path: '/api/health' });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
  });

  test('uses the function path without a conflicting health redirect', () => {
    expect(netlify).not.toMatch(/from\s*=\s*"\/api\/health"/);
    expect(netlify).toMatch(/\[functions\.health\][\s\S]*path\s*=\s*"\/api\/health"/);
  });
});
