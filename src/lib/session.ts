import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { Profile, NativeSessionResponse } from './types';

export type NativeSessionPayload = NativeSessionResponse;

type BrowserLocation = Pick<Location, 'hash' | 'origin'>;
type AuthClient = SupabaseClient<Database>;
type RestoredProfile = Pick<Profile, 'id' | 'name' | 'role'>;
type SupabaseResult<T> = { data: T | null; error: unknown | null };

let client: AuthClient | undefined;
let bootstrapPromise: Promise<Session | null> | null = null;
let currentProfile: Profile | null = null;

export function getSupabaseClient(): AuthClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error('Supabase client is not configured');
    client = createClient<Database>(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

function clearAccessFragment(): void {
  if (typeof window !== 'undefined' && window.history.replaceState) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
}

function browserLocation(): BrowserLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

function validProfile(value: unknown): value is Profile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === 'string' && typeof profile.name === 'string' &&
    (profile.role === 'teacher' || profile.role === 'admin');
}

function authError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; status?: unknown; message?: unknown };
  return value.code === 'PGRST301' || value.status === 401 ||
    (typeof value.message === 'string' && /invalid|expired|revoked|not authenticated|unauthori[sz]ed/i.test(value.message));
}

async function persistedSession(supabase: AuthClient): Promise<Session | null> {
  const result = await supabase.auth.getSession();
  if (result.error) {
    if (authError(result.error)) await clearSession();
    throw result.error;
  }
  const session = result.data.session;
  if (!session) return null;

  // The native client normally refreshes this itself. The explicit check also
  // makes the behavior deterministic when a persisted session is near expiry.
  if (typeof session.expires_at === 'number' && session.expires_at <= Math.floor(Date.now() / 1000) + 60) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session) {
      if (refreshed.error && authError(refreshed.error)) await clearSession();
      throw refreshed.error ?? new Error('session_refresh_failed');
    }
    return refreshed.data.session;
  }
  return session;
}

async function restoreProfile(session: Session, supabase: AuthClient): Promise<void> {
  const profileId = session.user.user_metadata?.class_scheduler_profile_id;
  try {
    const result = await supabase.from('profiles')
      .select('id, name, role')
      .eq(typeof profileId === 'string' ? 'id' : 'auth_user_id', profileId ?? session.user.id)
      .maybeSingle() as unknown as SupabaseResult<RestoredProfile>;
    if (!result.error && validProfile(result.data)) {
      currentProfile = result.data;
    }
  } catch {
    // A session remains usable while profile restoration is retried by the app.
  }
}

async function exchangeFragment(location: BrowserLocation, fetchImpl: typeof fetch): Promise<Session | null> {
  const supabase = getSupabaseClient();
  const existing = await persistedSession(supabase);
  if (existing) {
    await restoreProfile(existing, supabase);
    clearAccessFragment();
    return existing;
  }

  const token = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const response = await fetchImpl('/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error('invalid_access');
  const payload = await response.json() as Partial<NativeSessionPayload>;
  if (typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') {
    throw new Error('invalid_access');
  }

  const result = await supabase.auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (result.error || !result.data.session) throw result.error ?? new Error('invalid_access');
  if (validProfile(payload.profile)) currentProfile = payload.profile;
  else await restoreProfile(result.data.session, supabase);

  // The opaque link is only an exchange credential. The native refresh token
  // is persisted by Supabase and is the sole credential used after this point.
  clearAccessFragment();
  return result.data.session;
}

export function bootstrapNativeSession(
  location?: BrowserLocation,
  fetchImpl: typeof fetch = fetch,
): Promise<Session | null> {
  const resolvedLocation = location ?? browserLocation();
  if (!resolvedLocation) return Promise.resolve(null);
  if (!bootstrapPromise) {
    bootstrapPromise = exchangeFragment(resolvedLocation, fetchImpl).finally(() => {
      bootstrapPromise = null;
    });
  }
  return bootstrapPromise;
}

export function getProfile(): Profile | null {
  return currentProfile;
}

export function getProfileId(): string | null {
  return currentProfile?.id ?? null;
}

export async function clearSession(): Promise<void> {
  currentProfile = null;
  try {
    await getSupabaseClient().auth.signOut({ scope: 'local' });
  } catch {
    // A failed remote sign-out must not leave the local session available.
  }
}

export function onNativeAuthStateChange(
  callback: (session: Session | null, event: AuthChangeEvent) => void,
): { unsubscribe: () => void } {
  try {
    const { data } = getSupabaseClient().auth.onAuthStateChange((event, session) => {
      if (!session) currentProfile = null;
      callback(session, event);
    });
    return data.subscription;
  } catch {
    return { unsubscribe: () => undefined };
  }
}

/** Test-only reset; production code relies on the singleton native client. */
export function resetSessionForTests(): void {
  client = undefined;
  bootstrapPromise = null;
  currentProfile = null;
}

export function isSessionRevokedError(error: unknown): boolean {
  return authError(error);
}
