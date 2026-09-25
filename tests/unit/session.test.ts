import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import {
  bootstrapNativeSession,
  clearSession,
  getProfile,
  resetSessionForTests,
} from '../../src/lib/session';

const createClient = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  return { ...actual, createClient };
});

const token = 'a'.repeat(64);
const profile = { id: 'profile-id', name: 'Teacher', role: 'teacher' as const };
const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'auth-user', user_metadata: { class_scheduler_profile_id: profile.id } },
} as unknown as Session;

function clientStub(initial: Session | null = null, restoredProfile: unknown = profile) {
  let current = initial;
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: current }, error: null })),
    setSession: vi.fn(async () => { current = session; return { data: { session }, error: null }; }),
    refreshSession: vi.fn(async () => ({ data: { session }, error: null })),
    signOut: vi.fn(async () => { current = null; return { error: null }; }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  };
  const maybeSingle = vi.fn(async () => ({ data: restoredProfile, error: null }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { auth, from } as unknown as SupabaseClient, auth, from, select, eq, maybeSingle };
}

function accessResponse() {
  return new Response(JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('native browser session', () => {
  beforeEach(() => {
    resetSessionForTests();
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/access');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'publishable-key');
  });

  test('exchanges a valid fragment over a different persisted session and clears it only after success', async () => {
    const differentSession = {
      ...session,
      access_token: 'other-access',
      user: { id: 'other-auth', user_metadata: { class_scheduler_profile_id: 'other-profile' } },
    } as unknown as Session;
    const state = clientStub(differentSession);
    createClient.mockReturnValue(state.client);
    const fetchImpl = vi.fn(async () => accessResponse());
    window.history.replaceState(null, '', `/#${token}`);

    const result = await bootstrapNativeSession(window.location, fetchImpl);

    expect(result).toBe(session);
    expect(fetchImpl).toHaveBeenCalledWith('/api/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(state.auth.setSession).toHaveBeenCalledWith({ access_token: 'access-token', refresh_token: 'refresh-token' });
    expect(state.from).toHaveBeenCalledWith('profiles');
    expect(window.location.hash).toBe('');
    expect(getProfile()).toEqual(profile);
  });

  test('restores the persisted session and safe profile directly through RLS without a profile endpoint', async () => {
    const state = clientStub(session);
    createClient.mockReturnValue(state.client);
    const fetchImpl = vi.fn();

    const result = await bootstrapNativeSession({ hash: '', origin: window.location.origin }, fetchImpl);

    expect(result).toBe(session);
    expect(getProfile()).toEqual(profile);
    expect(state.from).toHaveBeenCalledWith('profiles');
    expect(state.select).toHaveBeenCalledWith('id, name, role');
    expect(state.eq).toHaveBeenCalledWith('id', profile.id);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('clears an unbound or inactive persisted session instead of falling back to a profile function', async () => {
    const state = clientStub(session, null);
    createClient.mockReturnValue(state.client);
    const fetchImpl = vi.fn();

    const result = await bootstrapNativeSession({ hash: '', origin: window.location.origin }, fetchImpl);

    expect(result).toBeNull();
    expect(state.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getProfile()).toBeNull();
  });

  test('keeps a failed fragment visible and leaves the existing native session untouched', async () => {
    const state = clientStub(session);
    createClient.mockReturnValue(state.client);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
    window.history.replaceState(null, '', `/#${token}`);

    await expect(bootstrapNativeSession(window.location, fetchImpl)).rejects.toThrow('invalid_access');

    expect(state.auth.setSession).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#${token}`);
  });

  test('clears a revoked native session through the client', async () => {
    const state = clientStub(session);
    createClient.mockReturnValue(state.client);

    await clearSession();

    expect(state.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
