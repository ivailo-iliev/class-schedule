import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { handleAccessRequest, isAccessToken } from '../../netlify/lib/access.mjs';

const token = 'a'.repeat(64);
const profile = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Teacher A',
  role: 'teacher',
  auth_user_id: '22222222-2222-2222-2222-222222222222',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; init: RequestInit };
const createdAuthUserId = '33333333-3333-3333-3333-333333333333';

function fetchStub(options: { profile?: typeof profile | null; consumed?: boolean } = {}) {
  const calls: Call[] = [];
  let consumed = options.consumed ?? false;
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/rpc/resolve_access')) return response(options.profile === null || consumed ? [] : [options.profile ?? profile]);
    if (url.endsWith('/auth/v1/admin/users')) {
      return response({ id: createdAuthUserId });
    }
    if (url.includes('/rest/v1/profiles?id=')) return response([]);
    if (url.endsWith('/auth/v1/admin/generate_link')) {
      return response({ hashed_token: 'native-one-time-token' });
    }
    if (url.endsWith('/auth/v1/verify')) {
      return response({ access_token: 'native-access', refresh_token: 'native-refresh', expires_in: 3600, user: { id: (options.profile ?? profile).auth_user_id ?? createdAuthUserId } });
    }
    if (url.endsWith('/rpc/consume_access')) {
      if (consumed) return response([]);
      consumed = true;
      return response([options.profile ?? profile]);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { calls, fetchImpl };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { origin: 'https://class-admin.netlify.app', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

const env = {
  APP_ORIGIN: 'https://class-admin.netlify.app',
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SECRET_API_KEY: 'service-key',
  SUPABASE_PUBLISHABLE_KEY: 'function-publishable-key',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
};

describe('native access exchange', () => {
  test('accepts exactly a lowercase 64-hex token', () => {
    expect(isAccessToken(token)).toBe(true);
    expect(isAccessToken(token.toUpperCase())).toBe(false);
    expect(isAccessToken('a'.repeat(63))).toBe(false);
    expect(isAccessToken(`${token}!`)).toBe(false);
  });

  test('exchanges once for a native Supabase session and consumes the token', async () => {
    const { calls, fetchImpl } = fetchStub();
    const result = await handleAccessRequest(request({ token }), { env, fetchImpl });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      access_token: 'native-access',
      refresh_token: 'native-refresh',
      profile: { id: profile.id, name: profile.name, role: profile.role },
    });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.headers['set-cookie']).toBe(
      `__Host-install=${token}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict`,
    );

    const rpc = calls.filter(call => call.url.includes('/rpc/'));
    expect(rpc.map(call => call.url.split('/').at(-1))).toEqual(['resolve_access', 'consume_access']);
    expect(JSON.parse(rpc[0]!.init.body as string)).toEqual({
      p_token_hash: createHash('sha256').update(token).digest('hex'),
    });
    const verify = calls.find(call => call.url.endsWith('/auth/v1/verify'))!;
    expect(JSON.parse(verify.init.body as string)).toEqual({ type: 'magiclink', token_hash: 'native-one-time-token' });
    expect(verify.init.headers).toMatchObject({ apikey: 'function-publishable-key', Authorization: 'Bearer function-publishable-key' });
  });

  test('creates and links the native auth user for a legacy profile on first exchange', async () => {
    const legacyProfile = { ...profile, auth_user_id: null };
    const { calls, fetchImpl } = fetchStub({ profile: legacyProfile });
    const result = await handleAccessRequest(request({ token }), { env, fetchImpl });

    expect(result.status).toBe(200);
    const create = calls.find(call => call.url.endsWith('/auth/v1/admin/users'))!;
    expect(JSON.parse(create.init.body as string)).toMatchObject({
      email: `profile-${legacyProfile.id}@access.invalid`,
      email_confirm: true,
    });
    const patch = calls.find(call => call.url.includes('/rest/v1/profiles?id='))!;
    expect(JSON.parse(patch.init.body as string)).toEqual({ auth_user_id: createdAuthUserId });
  });

  test('does not issue a second session after the database consumes the token', async () => {
    const state = fetchStub();
    const first = await handleAccessRequest(request({ token }), { env, fetchImpl: state.fetchImpl });
    const second = await handleAccessRequest(request({ token }), { env, fetchImpl: state.fetchImpl });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(state.calls.filter(call => call.url.endsWith('/auth/v1/verify'))).toHaveLength(1);
  });

  test('rejects wrong origin and malformed requests without calling Supabase', async () => {
    const { calls, fetchImpl } = fetchStub();
    const wrongOrigin = await handleAccessRequest(
      request({ token }, { origin: 'https://evil.example' }),
      { env, fetchImpl },
    );
    const malformed = await handleAccessRequest(request({ token: token.toUpperCase() }), { env, fetchImpl });

    expect(wrongOrigin.status).toBe(403);
    expect(malformed.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('rejects the 61st request from one IP in a 60-second window', async () => {
    const { fetchImpl } = fetchStub({ consumed: true });
    const results = await Promise.all(
      Array.from({ length: 61 }, () => handleAccessRequest({
        ...request({ token }),
        clientIp: '198.51.100.61',
      }, { env, fetchImpl })),
    );

    expect(results.slice(0, 60).every(result => result.status === 401)).toBe(true);
    expect(results[60]?.status).toBe(429);
    expect(JSON.parse(results[60]!.body)).toEqual({ error: 'rate_limited' });
  });

  test('rejects when consume loses the single-use race', async () => {
    const { calls, fetchImpl } = fetchStub({ consumed: true });
    const result = await handleAccessRequest(request({ token }), { env, fetchImpl });

    expect(result.status).toBe(401);
    expect(calls.some(call => call.url.endsWith('/auth/v1/verify'))).toBe(false);
  });
});
