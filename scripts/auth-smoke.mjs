#!/usr/bin/env node
// auth-smoke.mjs — prove genuine local gateway JWT acceptance, rejection,
// and revocation with a supported imported ES256 key.
// Exits nonzero on any unexpected status/result. No production secrets in
// the repo; read private key material from .env (never commit it).

import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  generateEs256Jwk,
  mintToken,
  verifyToken,
  publicJwk,
  loadPrivateJwk,
} from './lib/signing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KID = 'imported-key-1';

let env;
try {
  const envContent = readFileSync(join(ROOT, '.env'), 'utf-8');
  env = Object.fromEntries(envContent.replace(/\r\n/g, '\n').split('\n').map(l => {
    const [k, ...v] = l.split('=');
    return [k, v.join('=')];
  }).filter(([k]) => k && !k.startsWith('#')));
} catch {
  console.error('Missing .env — read SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_DB_URL from it');
  process.exit(2);
}

const SUPABASE_URL = env.SUPABASE_URL?.trim() || '';
const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY?.trim() || '';
const SUPABASE_DB_URL = env.SUPABASE_DB_URL?.trim() || '';
const SUPABASE_PROJECT_ID = env.SUPABASE_PROJECT_ID?.trim() || '';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. Ephemeral signing key for the smoke itself (unit-like proof that the
//    ES256 helpers verify claims, then we prove the live gateway does too).
// ---------------------------------------------------------------------------
const { privateJwk } = await generateEs256Jwk(KID);
const PROFILE = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Smoke Teacher', role: 'teacher', credential_version: 1 };
const { jwt } = await mintToken(PROFILE, privateJwk);

// Verify minted token under public JWK (unit property).
const payload = await verifyToken(jwt, privateJwk);
console.log(`Unit check — signed actor accepted: sub=${payload.sub} app=${payload.app}`);

// ---------------------------------------------------------------------------
// 2. Import the ephemeral public key into the hosted Supabase project's JWT
//    Signing Keys so the live gateway accepts tokens minted with the
//    matching private key. Owner-authorized hosted work only.
// ---------------------------------------------------------------------------
async function hosted(action, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${action}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'api-version': '2024-01-01',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`hosted ${action} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// Create standby imported key.
let keyId = null;
try {
  const created = await hosted('signing-keys', {
    algorithm: 'ES256',
    status: 'standby',
    public_key: JSON.stringify(publicJwk(privateJwk)),
    kid: KID,
  });
  keyId = created.id || KID;
  console.log(`Hosted standby key created/exists: kid=${keyId}`);
} catch (e) {
  // If the key already exists under the same kid, try to locate it.
  console.log(`Standby create note: ${e.message}`);
  keyId = KID;
}

// Activate the key via rotate — the hosted project now accepts ES256 tokens.
try {
  await hosted('signing-keys/rotate', { kid: keyId });
  console.log(`Hosted key rotated/activated: kid=${keyId}`);
} catch (e) {
  console.log(`Rotate note: ${e.message}`);
}

// Give the gateway a moment to pick up the key rotation.
await new Promise(r => setTimeout(r, 3000));

// ---------------------------------------------------------------------------
// 3. Acceptance — a token signed with the matching private key must be
//    accepted by the live Supabase Data API (real gateway, not SET ROLE).
// ---------------------------------------------------------------------------
const ACCEPT_PROFILE = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Smoke Teacher', role: 'teacher', credential_version: 1 };
const { jwt: acceptedJwt } = await mintToken(ACCEPT_PROFILE, privateJwk);

let accepted = false;
try {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, {
    headers: {
      apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || '',
      Authorization: `Bearer ${acceptedJwt}`,
      Prefer: 'return=representation',
    },
  });
  accepted = res.ok;
  console.log(`Acceptance — signed actor: HTTP ${res.status} ${accepted ? 'ACCEPTED' : 'DENIED'}`);
} catch (e) {
  console.error(`Acceptance request failed: ${e.message}`);
  process.exit(1);
}
if (!accepted) {
  console.error('Genuine signed token was rejected by the live gateway — signing-key gate failed.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Rejection — forged / wrong-key token must be denied by the real gateway.
// ---------------------------------------------------------------------------
const { privateJwk: wrongKey } = await generateEs256Jwk('wrong-key-2');
const { jwt: forgedJwt } = await mintToken(ACCEPT_PROFILE, wrongKey);

let forgedDenied = false;
try {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, {
    headers: {
      apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || '',
      Authorization: `Bearer ${forgedJwt}`,
    },
  });
  forgedDenied = !res.ok;
  console.log(`Rejection — forged/wrong-key actor: HTTP ${res.status} ${forgedDenied ? 'DENIED' : 'ACCEPTED'}`);
} catch (e) {
  console.error(`Rejection request failed: ${e.message}`);
  process.exit(1);
}
if (!forgedDenied) {
  console.error('Forged token was accepted by the live gateway — signing-key gate failed.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 5. Revocation — after deleting the imported key, the accepted JWT must no
//    longer be accepted by the live gateway on subsequent statements.
// ---------------------------------------------------------------------------
try {
  await hosted(`signing-keys/${keyId}`, {});
  console.log(`Hosted key deleted: kid=${keyId}`);
} catch (e) {
  console.log(`Delete note: ${e.message}`);
}

await new Promise(r => setTimeout(r, 3000));

let revokedDenied = false;
try {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, {
    headers: {
      apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || '',
      Authorization: `Bearer ${acceptedJwt}`,
    },
  });
  revokedDenied = !res.ok;
  console.log(`Revocation — previously accepted actor after key delete: HTTP ${res.status} ${revokedDenied ? 'DENIED' : 'ACCEPTED'}`);
} catch (e) {
  console.error(`Revocation request failed: ${e.message}`);
  process.exit(1);
}
if (!revokedDenied) {
  console.error('Revoked token was still accepted by the live gateway — signing-key gate failed.');
  process.exit(1);
}

console.log('signed actor accepted; forged actor denied; revoked actor denied');
process.exit(0);
