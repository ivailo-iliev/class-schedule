import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

export type NativeSessionPayload = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
  user?: Session['user'];
  profile: { id: string; name: string; role: 'teacher' | 'admin' };
};

let client: SupabaseClient<Database> | undefined;

export function getSupabaseClient(): SupabaseClient<Database> {
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

function clearAccessFragment() {
  if (typeof window !== 'undefined' && window.history.replaceState) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
}

export async function bootstrapNativeSession(
  location: Pick<Location, 'hash' | 'origin'> = window.location,
  fetchImpl: typeof fetch = fetch,
): Promise<Session | null> {
  const supabase = getSupabaseClient();
  const existing = await supabase.auth.getSession();
  if (existing.data.session) {
    clearAccessFragment();
    return existing.data.session;
  }

  const token = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const response = await fetchImpl('/api/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: location.origin },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error('invalid_access');
  const payload = await response.json() as NativeSessionPayload;
  if (!payload.access_token || !payload.refresh_token) throw new Error('invalid_access');
  const { data, error } = await supabase.auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
  });
  if (error || !data.session) throw new Error('invalid_access');

  // Remove the bearer fragment after the one-time exchange. Native refresh
  // tokens, not the access link, keep this browser and its PWA authenticated.
  clearAccessFragment();
  return data.session;
}
