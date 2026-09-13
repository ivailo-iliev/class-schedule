// Shared ES256 JWT signing/verification helpers for the class-scheduler.
//
// Used by:
//   - scripts/create-local-key.mjs  (generate a disposable local signing key)
//   - scripts/auth-smoke.mjs        (genuine local Data API acceptance/rejection/revocation)
//   - netlify/lib/access.ts        (Task 12: exchange personal links for bounded JWTs)
//
// The signing key is an imported ES256 (P-256) JWK. We sign with `jose` using
// `importJWK` (NOT `importPKCS8`, which expects a PEM — the Supabase CLI emits a
// raw JWK with a `d` component, not a PEM). The gateway (Supabase GoTrue / the
// hosted JWT Signing Keys feature) is configured to trust the matching public JWK.

import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair } from 'jose';

const DEFAULT_AUD = 'supabase';
const DEFAULT_ISS = 'class-scheduler-exchange';
const DEFAULT_APP = 'class-scheduler-v1';
const EXPIRY_SECONDS = 600;

export function publicJwk(privateJwk) {
  const { d, ...pub } = privateJwk;
  return pub;
}

// Mint a short-lived ES256 JWT for a profile. `key` is a private JWK (with `d`).
export async function mintToken(profile, privateJwk, opts = {}) {
  const kid = privateJwk.kid ?? opts.kid ?? 'imported-key-1';
  const key = await importJWK(privateJwk, 'ES256');
  const expiresAt = Math.floor(Date.now() / 1000) + (opts.expirySeconds ?? EXPIRY_SECONDS);
  const jwt = await new SignJWT({
    sub: profile.id,
    role: 'authenticated',
    app: opts.app ?? DEFAULT_APP,
    credential_version: profile.credential_version,
    aud: opts.aud ?? DEFAULT_AUD,
    iss: opts.iss ?? DEFAULT_ISS,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key);
  return { jwt, expiresAt, kid };
}

// Verify a JWT against a private/public JWK. Returns the payload, or throws on
// any tampering, wrong key, or expiry.
export async function verifyToken(jwt, jwk, opts = {}) {
  const key = await importJWK(publicJwk(jwk), 'ES256');
  const { payload } = await jwtVerify(jwt, key, {
    issuer: opts.iss ?? DEFAULT_ISS,
    audience: opts.aud ?? DEFAULT_AUD,
  });
  return payload;
}

// Generate a fresh disposable ES256 key pair as JWKs (private includes `d`).
export async function generateEs256Jwk(kid = 'imported-key-1') {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const privJwk = await exportJWK(privateKey);
  privJwk.kid = kid;
  const pubJwk = await exportJWK(publicKey);
  pubJwk.kid = kid;
  return { privateJwk: privJwk, publicJwk: pubJwk };
}

// Load a private signing JWK from an explicit source: { env } or { file }.
export async function loadPrivateJwk({ envName, filePath } = {}) {
  if (envName && process.env[envName]) {
    return JSON.parse(process.env[envName]);
  }
  if (filePath) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(filePath, 'utf-8'));
  }
  throw new Error('no signing key source provided (set envName or filePath)');
}
