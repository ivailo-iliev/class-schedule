#!/usr/bin/env node
// Verify the native Supabase session exchange against LOCAL Supabase.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { handleAccessRequest } from '../netlify/lib/access.mjs';

const root = new URL('..', import.meta.url);
const envPath = new URL('.env', root);
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const fileEnv = Object.fromEntries(envText.split(/\r?\n/)
  .filter(line => line && !line.startsWith('#'))
  .map(line => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
  }));
const value = (...names) => names.map(name => process.env[name] ?? fileEnv[name]).find(Boolean);
const base = value('LOCAL_SUPABASE_URL', 'API_URL', 'SUPABASE_URL') ?? 'http://127.0.0.1:54321';
const key = value('LOCAL_SUPABASE_PUBLISHABLE_KEY', 'PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const serviceKey = value('LOCAL_SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_API_KEY', 'SUPABASE_SECRET_KEY');
if (!key || !serviceKey) throw new Error('local Supabase publishable/service keys are required');
const origin = value('APP_ORIGIN') ?? 'http://127.0.0.1:4173';
const id = randomUUID();
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const email = `native-smoke-${id}@access.invalid`;
const otherEmail = `native-smoke-other-${id}@access.invalid`;
const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };
const publicHeaders = { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };

async function api(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function rest(path, init = {}) {
  return api(`/rest/v1${path}`, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers ?? {}) },
  });
}

async function issueSession(userEmail) {
  const link = await api('/auth/v1/admin/generate_link', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ type: 'magiclink', email: userEmail }),
  });
  const tokenHash = link?.hashed_token ?? link?.properties?.hashed_token;
  if (typeof tokenHash !== 'string' || !tokenHash) throw new Error('native link was not generated');
  return api('/auth/v1/verify', {
    method: 'POST', headers: publicHeaders,
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
}

let profileId;
let classId;
let userId;
let otherUserId;
try {
  const profile = await rest('/profiles', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: `Native smoke ${id.slice(0, 8)}`, role: 'teacher', active: true, access_token_hash: hash }),
  });
  profileId = profile[0]?.id;
  if (!profileId) throw new Error('smoke profile was not created');

  const exchange = await handleAccessRequest({
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }, {
    env: {
      APP_ORIGIN: origin,
      SUPABASE_URL: base,
      SUPABASE_SECRET_API_KEY: serviceKey,
      SUPABASE_PUBLISHABLE_KEY: key,
    },
    fetchImpl: fetch,
  });
  if (exchange.status !== 200) throw new Error(`access exchange: HTTP ${exchange.status}`);
  const session = JSON.parse(exchange.body);
  if (!session.user?.id || !session.access_token || !session.refresh_token) {
    throw new Error('native session payload is incomplete');
  }
  userId = session.user.id;
  console.log('access exchange: PASS (native session returned)');

  const secondExchange = await handleAccessRequest({
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }, {
    env: {
      APP_ORIGIN: origin,
      SUPABASE_URL: base,
      SUPABASE_SECRET_API_KEY: serviceKey,
      SUPABASE_PUBLISHABLE_KEY: key,
    },
    fetchImpl: fetch,
  });
  if (secondExchange.status !== 200) throw new Error('personal access link was not reusable');
  const secondSession = JSON.parse(secondExchange.body);
  if (!secondSession.access_token || !secondSession.refresh_token) {
    throw new Error('reused access link did not return a native session');
  }
  if (secondSession.user?.id !== userId) {
    throw new Error('reused access link returned a different native user');
  }
  console.log('reusable personal link: PASS');

  const teacherHeaders = { apikey: key, Authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
  const classRows = await api('/rest/v1/classes', {
    method: 'POST', headers: { ...teacherHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({ teacher_id: profileId, name: `Smoke class ${id.slice(0, 8)}`, active: true }),
  });
  classId = classRows[0]?.id;
  if (!classId) throw new Error('owner RLS write failed');
  console.log('RLS owner write: PASS');

  const other = await api('/auth/v1/admin/users', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ email: otherEmail, email_confirm: true }),
  });
  otherUserId = other.id;
  const otherSession = await issueSession(otherEmail);
  const crossRows = await api(`/rest/v1/classes?id=eq.${classId}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${otherSession.access_token}`, 'content-type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ name: 'forbidden' }),
  });
  if (crossRows.length !== 0) throw new Error('cross-teacher write was allowed');
  console.log('RLS cross-teacher denial: PASS');

  await rest(`/profiles?id=eq.${profileId}`, {
    method: 'PATCH', body: JSON.stringify({ active: false }),
  });
  const revoked = await api('/rest/v1/profiles?select=id', { headers: teacherHeaders });
  if (revoked.length !== 0) throw new Error('deactivated profile retained API access');
  console.log('deactivation revocation: PASS');
} finally {
  if (classId) await rest(`/classes?id=eq.${classId}`, { method: 'DELETE' }).catch(() => {});
  if (profileId) await rest(`/profiles?id=eq.${profileId}`, { method: 'DELETE' }).catch(() => {});
  if (userId) await api(`/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {});
  if (otherUserId) await api(`/auth/v1/admin/users/${otherUserId}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {});
}
