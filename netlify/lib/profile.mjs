const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'netlify-cdn-cache-control': 'no-store',
};

function result(status, body) {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function header(headers, name) {
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(headers[key] ?? '') : '';
}

function bearer(headers) {
  const value = header(headers, 'authorization');
  return /^Bearer\s+\S+$/i.test(value) ? value : '';
}

async function jsonRequest(url, init, fetchImpl) {
  const response = await fetchImpl(url, init);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error */ }
  if (!response.ok) throw new Error(`supabase request failed (${response.status})`);
  return body;
}

export async function handleProfileRequest(request, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SECRET_API_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const authorization = bearer(request.headers);

  if (String(request.method ?? '').toUpperCase() !== 'GET' || !supabaseUrl || !serviceKey || !publishableKey || !authorization) {
    return result(401, { error: 'profile_access_denied' });
  }

  try {
    const user = await jsonRequest(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: authorization },
    }, fetchImpl);
    if (typeof user?.id !== 'string') return result(401, { error: 'profile_access_denied' });

    const query = new URLSearchParams({
      select: 'id,name,role',
      auth_user_id: `eq.${user.id}`,
      active: 'eq.true',
      limit: '1',
    });
    const profiles = await jsonRequest(`${supabaseUrl}/rest/v1/profiles?${query}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    }, fetchImpl);
    const profile = Array.isArray(profiles) ? profiles[0] : null;
    if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' ||
        (profile.role !== 'teacher' && profile.role !== 'admin')) {
      return result(401, { error: 'profile_access_denied' });
    }
    return result(200, { id: profile.id, name: profile.name, role: profile.role });
  } catch {
    return result(401, { error: 'profile_access_denied' });
  }
}
