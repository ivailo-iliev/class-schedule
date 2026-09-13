import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { handleManifestRequest, installCookieValue, isProfileId } from '../../netlify/lib/manifest.mjs';

const profileA = '11111111-1111-4111-8111-111111111111';
const profileB = '22222222-2222-4222-8222-222222222222';
const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const env = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SECRET_API_KEY: 'service-key',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function request(profile: string, token = tokenA, cookiePrefix = '') {
  return {
    method: 'GET',
    queryStringParameters: { profile },
    headers: { cookie: `${cookiePrefix}__Host-install=${token}` },
  };
}

function fetchStub(rows: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return response(rows);
  };
  return { calls, fetchImpl };
}

function expectPrivateNoStore(result: { headers: Record<string, string> }) {
  expect(result.headers['content-type']).toBe('application/manifest+json');
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.headers['netlify-cdn-cache-control']).toBe('no-store');
  expect(result.headers.vary).toBe('Cookie');
}

describe('private installation manifest', () => {
  test('validates profile selectors and extracts only the install cookie', () => {
    expect(isProfileId(profileA)).toBe(true);
    expect(isProfileId('not-a-uuid')).toBe(false);
    expect(installCookieValue({ Cookie: `other=x; __Host-install=${tokenA}; theme=dark` })).toBe(tokenA);
    expect(installCookieValue({ cookie: '__Host-install=not-hex' })).toBe('');
  });

  test('returns a profile-specific manifest for a matching active cookie', async () => {
    const { calls, fetchImpl } = fetchStub([{ id: profileA, name: 'Teacher A' }]);
    const result = await handleManifestRequest(request(profileA), { env, fetchImpl });
    const manifest = JSON.parse(result.body);

    expect(result.status).toBe(200);
    expectPrivateNoStore(result);
    expect(manifest).toMatchObject({
      id: '/',
      scope: '/',
      start_url: '/',
      display: 'standalone',
      short_name: 'Teacher A',
    });
    expect(manifest.start_url).not.toContain(tokenA);
    expect(manifest.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/rest/v1/profiles');
    expect(url.searchParams.get('id')).toBe(`eq.${profileA}`);
    expect(url.searchParams.get('access_token_hash')).toBe(
      `eq.${createHash('sha256').update(tokenA).digest('hex')}`,
    );
    expect(url.searchParams.get('active')).toBe('eq.true');
    expect(calls[0]!.init.headers).toMatchObject({ apikey: 'service-key', Authorization: 'Bearer service-key' });
  });

  test('rejects an absent or malformed cookie with private no-store headers', async () => {
    const { calls, fetchImpl } = fetchStub([{ id: profileA, name: 'Teacher A' }]);
    const missing = await handleManifestRequest({
      ...request(profileA),
      headers: {},
    }, { env, fetchImpl });
    const malformed = await handleManifestRequest({
      ...request(profileA),
      headers: { cookie: '__Host-install=bad' },
    }, { env, fetchImpl });

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expectPrivateNoStore(missing);
    expectPrivateNoStore(malformed);
    expect(calls).toHaveLength(0);
  });

  test('rejects a missing or mismatched profile selector', async () => {
    const { fetchImpl } = fetchStub([{ id: profileA, name: 'Teacher A' }]);
    const missing = await handleManifestRequest(request(''), { env, fetchImpl });
    const mismatched = await handleManifestRequest(request(profileB), { env, fetchImpl });

    expect(missing.status).toBe(400);
    expect(mismatched.status).toBe(403);
    expectPrivateNoStore(missing);
    expectPrivateNoStore(mismatched);
  });

  test('rejects invalid and revoked cookies', async () => {
    const { fetchImpl } = fetchStub([]);
    const result = await handleManifestRequest(request(profileA, tokenB), { env, fetchImpl });

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: 'manifest_forbidden' });
    expectPrivateNoStore(result);
  });

  test('never returns teacher A manifest for teacher B cookie and selector', async () => {
    const { fetchImpl } = fetchStub([{ id: profileB, name: 'Teacher B' }]);
    const result = await handleManifestRequest(request(profileA, tokenB), { env, fetchImpl });

    expect(result.status).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: 'manifest_forbidden' });
    expectPrivateNoStore(result);
  });

  test('does not consume a valid cookie, so the browser can refetch the manifest', async () => {
    const { fetchImpl } = fetchStub([{ id: profileA, name: 'Teacher A' }]);
    const first = await handleManifestRequest(request(profileA), { env, fetchImpl });
    const second = await handleManifestRequest(request(profileA), { env, fetchImpl });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body).short_name).toBe('Teacher A');
  });

  test('applies no-store headers to provider failures', async () => {
    const result = await handleManifestRequest(request(profileA), {
      env,
      fetchImpl: async () => response({ error: 'down' }, 503),
    });

    expect(result.status).toBe(503);
    expectPrivateNoStore(result);
  });
});
