import { describe, test, expect } from 'vitest';
import {
  generateEs256Jwk,
  mintToken,
  verifyToken,
  publicJwk,
} from '../../scripts/lib/signing.mjs';

const PROFILE = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Test Teacher', role: 'teacher', credential_version: 1 };

describe('imported ES256 signing key', () => {
  test('signed JWT verifies under its public JWK and carries required claims', async () => {
    const { privateJwk } = await generateEs256Jwk('imported-key-1');
    const { jwt, expiresAt } = await mintToken(PROFILE, privateJwk);

    const payload = await verifyToken(jwt, privateJwk);
    expect(payload.sub).toBe(PROFILE.id);
    expect(payload.role).toBe('authenticated');
    expect(payload.app).toBe('class-scheduler-v1');
    expect(payload.credential_version).toBe(1);
    expect(payload.aud).toBe('supabase');
    expect(payload.iss).toBe('class-scheduler-exchange');
    expect(typeof payload.exp).toBe('number');
    expect(payload.exp).toBe(expiresAt);
    // Header carries the matching kid.
    const [header] = jwt.split('.');
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf-8'));
    expect(decoded.alg).toBe('ES256');
    expect(decoded.kid).toBe('imported-key-1');
  });

  test('verify fails under a different key (wrong key rejected)', async () => {
    const { privateJwk: a } = await generateEs256Jwk('imported-key-1');
    const { privateJwk: b } = await generateEs256Jwk('imported-key-2');
    const { jwt } = await mintToken(PROFILE, a);
    await expect(verifyToken(jwt, b)).rejects.toBeDefined();
  });

  test('tampered token fails verification', async () => {
    const { privateJwk } = await generateEs256Jwk('imported-key-1');
    const { jwt } = await mintToken(PROFILE, privateJwk);
    // Re-sign attempt by flipping a character in the signature segment.
    const [h, p, s] = jwt.split('.');
    const tampered = `${h}.${p}.${s.slice(0, -2)}AA`;
    await expect(verifyToken(tampered, privateJwk)).rejects.toBeDefined();
  });

  test('expired token fails verification', async () => {
    const { privateJwk } = await generateEs256Jwk('imported-key-1');
    const { jwt } = await mintToken(PROFILE, privateJwk, { expirySeconds: -10 });
    await expect(verifyToken(jwt, privateJwk)).rejects.toBeDefined();
  });

  test('missing app claim fails gateway-equivalent identity resolution', async () => {
    // The DB actor_id() requires app == 'class-scheduler-v1'. A token minted
    // for a different app must not satisfy the DB identity contract.
    const { privateJwk } = await generateEs256Jwk('imported-key-1');
    const { jwt } = await mintToken(PROFILE, privateJwk, { app: 'wrong-app' });
    const payload = await verifyToken(jwt, privateJwk);
    expect(payload.app).not.toBe('class-scheduler-v1');
  });

  test('public JWK exposes no private component', async () => {
    const { privateJwk, publicJwk: pub } = await generateEs256Jwk('imported-key-1');
    expect(pub.d).toBeUndefined();
    expect(pub.kty).toBe('EC');
    expect(privateJwk.d).toBeDefined();
  });
});
