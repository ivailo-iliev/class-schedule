import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';
import App from '../../src/App';
import {
  bootstrapNativeSession,
  clearSession,
  resetSessionForTests,
} from '../../src/lib/session';

const createClient = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  return { ...actual, createClient };
});

const token = 'a'.repeat(64);
const session = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'auth-user' },
} as unknown as Session;

function authStub(initial: Session | null = null) {
  let current = initial;
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: current }, error: null })),
    setSession: vi.fn(async () => ({ data: { session }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session }, error: null })),
    signOut: vi.fn(async () => { current = null; return { error: null }; }),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  };
  return auth;
}

function accessResponse() {
  return new Response(JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    profile: { id: 'profile-id', name: 'Teacher', role: 'teacher' },
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

  test('exchanges a valid fragment once and removes the bearer fragment', async () => {
    const auth = authStub();
    createClient.mockReturnValue({ auth } as unknown as SupabaseClient);
    const fetchImpl = vi.fn(async () => accessResponse());
    window.history.replaceState(null, '', `/#${token}`);

    const result = await bootstrapNativeSession(window.location, fetchImpl);
    await bootstrapNativeSession(window.location, fetchImpl);

    expect(result).toBe(session);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(auth.setSession).toHaveBeenCalledWith({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    });
    expect(window.location.hash).toBe('');
  });

  test('refreshes an expired persisted session without exchanging the access link', async () => {
    const expired = { ...session, expires_at: Math.floor(Date.now() / 1000) - 1 } as Session;
    const auth = authStub(expired);
    createClient.mockReturnValue({ auth } as unknown as SupabaseClient);
    const fetchImpl = vi.fn(async () => accessResponse());

    const result = await bootstrapNativeSession({ hash: `#${token}`, origin: window.location.origin }, fetchImpl);

    expect(result).toBe(session);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('clears a revoked native session through the client', async () => {
    const auth = authStub(session);
    createClient.mockReturnValue({ auth } as unknown as SupabaseClient);

    await clearSession();

    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('does not put the access token in rendered component state', async () => {
    const auth = authStub();
    createClient.mockReturnValue({ auth } as unknown as SupabaseClient);
    const fetchImpl = vi.fn(async () => accessResponse());
    vi.stubGlobal('fetch', fetchImpl);
    window.history.replaceState(null, '', `/#${token}`);
    render(createElement(App));
    await waitFor(() => expect(document.body.textContent).toContain('Connected'));

    expect(document.body.textContent ?? '').not.toContain(token);
  });
});
