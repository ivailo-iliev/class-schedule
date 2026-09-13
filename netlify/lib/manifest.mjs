import { createHash } from 'node:crypto';

const MANIFEST_HEADERS = {
  'content-type': 'application/manifest+json',
  'cache-control': 'private, no-store',
  'netlify-cdn-cache-control': 'no-store',
  vary: 'Cookie',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const INSTALL_COOKIE_TTL_MS = 600_000;

function result(status, body) {
  return {
    status,
    headers: { ...MANIFEST_HEADERS },
    body: JSON.stringify(body),
  };
}

function header(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(headers[key] ?? '') : '';
}

function cookieValue(cookieHeader, cookieName) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

function authHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function supabaseRequest(baseUrl, path, init, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}${path}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error */ }
  if (!response.ok) throw new Error(`supabase request failed (${response.status})`);
  return body;
}

export function isProfileId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function installCookieValue(headers) {
  const raw = cookieValue(header(headers, 'cookie'), '__Host-install');
  return TOKEN.test(raw) ? raw : '';
}

export async function handleManifestRequest(request, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = String(request.method ?? '').toUpperCase();
  const profileId = request.profileId ?? request.queryStringParameters?.profile;

  if (method !== 'GET' || !isProfileId(profileId)) return result(400, { error: 'invalid_manifest' });

  const installToken = installCookieValue(request.headers);
  if (!installToken) return result(401, { error: 'manifest_access_required' });

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SECRET_API_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) return result(500, { error: 'manifest_unavailable' });

  const tokenHash = createHash('sha256').update(installToken, 'utf8').digest('hex');
  const query = new URLSearchParams({
    id: `eq.${profileId}`,
    access_token_hash: `eq.${tokenHash}`,
    active: 'eq.true',
    access_token_used_at: `gt.${new Date((options.now ?? Date.now()) - INSTALL_COOKIE_TTL_MS).toISOString()}`,
    select: 'id,name',
  });

  try {
    const rows = await supabaseRequest(`${supabaseUrl}`, `/rest/v1/profiles?${query}`, {
      method: 'GET',
      headers: authHeaders(serviceKey),
    }, fetchImpl);
    const profile = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!profile || profile.id !== profileId || typeof profile.name !== 'string' || !profile.name) {
      return result(403, { error: 'manifest_forbidden' });
    }

    return result(200, {
      id: '/',
      name: `${profile.name} — Class Scheduler`,
      short_name: profile.name,
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#1f2937',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch {
    return result(503, { error: 'manifest_unavailable' });
  }
}
