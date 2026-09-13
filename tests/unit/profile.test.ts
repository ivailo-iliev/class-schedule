import { describe, expect, test } from 'vitest';
import { handleProfileRequest } from '../../netlify/lib/profile.mjs';

const env = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SECRET_API_KEY: 'service-key',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('current profile endpoint', () => {
  test('returns only the authenticated teacher profile', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/auth/v1/user')) return response({ id: 'auth-user' });
      if (url.includes('/rest/v1/profiles?')) return response([
        { id: 'profile-id', name: 'Teacher', role: 'teacher' },
      ]);
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await handleProfileRequest({
      method: 'GET',
      headers: { authorization: 'Bearer signed-in-session' },
    }, { env, fetchImpl });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ id: 'profile-id', name: 'Teacher', role: 'teacher' });
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(calls[0]?.init.headers).toMatchObject({
      apikey: 'publishable-key',
      Authorization: 'Bearer signed-in-session',
    });
    expect(calls[1]?.url).toContain('auth_user_id=eq.auth-user');
  });

  test('rejects unauthenticated requests without contacting Supabase', async () => {
    const fetchImpl = async () => response({});
    const result = await handleProfileRequest({ method: 'GET', headers: {} }, { env, fetchImpl });

    expect(result.status).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'profile_access_denied' });
  });
});
