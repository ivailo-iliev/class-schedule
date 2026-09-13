// Generate a disposable local ES256 signing key for the local Supabase gateway.
//
// This is the local-only equivalent of the hosted "imported signing key"
// flow (Supabase JWT Signing Keys). The private JWK is kept in `.keys/`
// (gitignored) for the auth-smoke script and Task 12's function. The same
// raw private JWK is written to `supabase/signing_keys.json` (gitignored) so
// the local gateway uses it as its signing/verification key via
// `signing_keys_path`.
//
// Never commit `.keys/` or `supabase/signing_keys.json`. See `.gitignore`.

import { execSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const supDir = resolve(repoRoot, 'supabase');
const gatewayKeyPath = resolve(supDir, 'signing_keys.json'); // public JWKS trusted by gateway
const keysDir = resolve(repoRoot, '.keys');
const privateKeyPath = resolve(keysDir, 'local_signing_key.json'); // private JWK (signer only)

const kid = process.env.KID || 'imported-key-1';

function generateRawJwk() {
  // Supabase CLI emits a single JWK (with `d`) as JSON to stdout.
  const out = execSync(`supabase gen signing-key --algorithm ES256 --output-format json`, {
    cwd: supDir,
    encoding: 'utf-8',
  });
  return JSON.parse(out.trim());
}

mkdirSync(keysDir, { recursive: true });

if (existsSync(privateKeyPath)) {
  process.stdout.write(`Private key exists at ${privateKeyPath}; keeping.\n`);
} else {
  const full = generateRawJwk();
  full.kid = kid;
  writeFileSync(privateKeyPath, JSON.stringify(full, null, 2) + '\n');
  process.stdout.write(`ES256 private signing key written to ${privateKeyPath}\n`);
}

// The local Supabase gateway is configured to use this same imported ES256 key
// (raw private JWK, as emitted by the CLI) as its signing/verification key via
// `signing_keys_path`. The gateway signs its own anon/service tokens with it and
// verifies the custom JWTs our exchange function mints with the matching private
// JWK in `.keys/`. This ensures a single key pair backs both the gateway JWTs
// and the application-issued ones — a single imported ES256 key.
const priv = JSON.parse(readFileSync(privateKeyPath, 'utf-8'));
writeFileSync(gatewayKeyPath, JSON.stringify(priv, null, 2) + '\n');
process.stdout.write(`Gateway signing key written to ${gatewayKeyPath}\n`);
