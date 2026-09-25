import { createHash } from 'node:crypto';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'netlify-cdn-cache-control': 'no-store',
};

const ACCESS_RATE_LIMIT = 60;
const ACCESS_RATE_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_BUCKETS = 10_000;
const rateLimitBuckets = new Map();

export function isAccessToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function result(status, body, headers = {}) {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) };
}

function rateLimitKey(clientIp) {
  return typeof clientIp === 'string' && clientIp.trim() ? clientIp.trim().slice(0, 128) : 'unknown';
}

function isRateLimited(clientIp, now = Date.now()) {
  const key = rateLimitKey(clientIp);
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= ACCESS_RATE_WINDOW_MS || now < bucket.windowStart) {
    if (!bucket && rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      rateLimitBuckets.delete(rateLimitBuckets.keys().next().value);
    }
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  bucket.count += 1;
  return bucket.count > ACCESS_RATE_LIMIT;
}

function header(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(headers[key] ?? '') : '';
}

function invalid(status = 400) {
  return result(status, { error: 'invalid_access' });
}

async function supabaseRequest(baseUrl, path, init, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}${path}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error */ }
  if (!response.ok) throw new Error(`supabase request failed (${response.status})`);
  return body;
}

function authHeaders(key, contentType = false) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...(contentType ? { 'content-type': 'application/json' } : {}),
  };
}

function emailForProfile(id) {
  return `profile-${id}@access.invalid`;
}

async function ensureNativeUser(profile, config) {
  if (profile.auth_user_id) return profile.auth_user_id;
  const email = emailForProfile(profile.id);
  const user = await supabaseRequest(config.supabaseUrl, '/auth/v1/admin/users', {
    method: 'POST',
    headers: authHeaders(config.serviceKey, true),
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { class_scheduler_profile_id: profile.id } }),
  }, config.fetchImpl);
  const authUserId = user?.id;
  if (typeof authUserId !== 'string') throw new Error('native user was not created');

  await supabaseRequest(config.supabaseUrl, `/rest/v1/profiles?id=eq.${encodeURIComponent(profile.id)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(config.serviceKey, true), Prefer: 'return=minimal' },
    body: JSON.stringify({ auth_user_id: authUserId }),
  }, config.fetchImpl);
  return authUserId;
}

async function nativeSession(profile, config) {
  const authUserId = await ensureNativeUser(profile, config);
  const email = emailForProfile(profile.id);
  const link = await supabaseRequest(config.supabaseUrl, '/auth/v1/admin/generate_link', {
    method: 'POST',
    headers: authHeaders(config.serviceKey, true),
    body: JSON.stringify({ type: 'magiclink', email }),
  }, config.fetchImpl);
  const tokenHash = link?.hashed_token ?? link?.properties?.hashed_token;
  if (typeof tokenHash !== 'string' || !tokenHash) throw new Error('native link was not generated');

  const session = await supabaseRequest(config.supabaseUrl, '/auth/v1/verify', {
    method: 'POST',
    headers: authHeaders(config.publishableKey, true),
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  }, config.fetchImpl);
  if (session?.user?.id !== authUserId ||
      typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') {
    throw new Error('native session was not returned');
  }
  return session;
}

export async function handleAccessRequest(request, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (isRateLimited(request.clientIp, options.now)) {
    return result(429, { error: 'rate_limited' }, { 'retry-after': '60' });
  }
  const appOrigin = env.APP_ORIGIN;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SECRET_API_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
  // Native verification runs in the function. Prefer its function-scoped key
  // so a stale or rotated build variable cannot break the live exchange.
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const origin = header(request.headers, 'origin');
  const contentType = header(request.headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
  if (!appOrigin || !supabaseUrl || !serviceKey || !publishableKey || origin !== appOrigin ||
      String(request.method ?? '').toUpperCase() !== 'POST' || contentType !== 'application/json' ||
      typeof request.body !== 'string' || Buffer.byteLength(request.body, 'utf8') > 1024) {
    return invalid(origin && origin !== appOrigin ? 403 : 400);
  }

  let body;
  try { body = JSON.parse(request.body); } catch { return invalid(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !isAccessToken(body.token)) return invalid();

  const tokenHash = createHash('sha256').update(body.token, 'utf8').digest('hex');
  const config = { supabaseUrl, serviceKey, publishableKey, fetchImpl };
  try {
    const rows = await supabaseRequest(supabaseUrl, '/rest/v1/rpc/resolve_access', {
      method: 'POST',
      headers: authHeaders(serviceKey, true),
      body: JSON.stringify({ p_token_hash: tokenHash }),
    }, fetchImpl);
    const profile = Array.isArray(rows) ? rows[0] : null;
    if (!profile?.id || !profile.name || !profile.role) return invalid(401);

    const session = await nativeSession(profile, config);
    const consumed = await supabaseRequest(supabaseUrl, '/rest/v1/rpc/consume_access', {
      method: 'POST',
      headers: authHeaders(serviceKey, true),
      body: JSON.stringify({ p_token_hash: tokenHash }),
    }, fetchImpl);
    if (!Array.isArray(consumed) || consumed.length !== 1 || consumed[0].id !== profile.id) return invalid(401);

    return result(200, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      user: session.user,
      profile: { id: profile.id, name: profile.name, role: profile.role },
    });
  } catch {
    return invalid(401);
  }
}
