import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const dist = resolve(root, 'dist');
const netlifyConfigPath = resolve(root, 'netlify.toml');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
  fail('PUBLIC BUILD CHECK: dist directory is missing');
}

function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(absolute, relative));
    else if (entry.isFile()) files.push({ absolute, relative });
  }
  return files;
}

const prohibitedNames = [
  'SUPABASE_SECRET_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_URL',
  'APP_ORIGIN',
  'SUPABASE_DB_URL',
  'SUPABASE_JWKS_URL',
  'SIGNING_JWK',
  'PRIVATE_KEY',
  'ENCRYPTION_KEY',
  'access_token_hash',
  'access_token_used_at',
  '__Host-install=',
];
const personalToken = /(?:^|[^0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i;
const serverOnlyEnvironmentNames = [
  'SUPABASE_SECRET_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_DB_URL',
  'SIGNING_JWK',
  'SUPABASE_JWKS_URL',
];

const files = filesUnder(dist);
for (const file of files) {
  const text = readFileSync(file.absolute, 'utf8');
  const prohibited = prohibitedNames.find((needle) => text.includes(needle));
  if (prohibited || personalToken.test(text) || file.relative.startsWith('.keys/')) {
    fail(`SECRET LEAK: ${file.relative} contains prohibited public-build content`);
  }

  for (const name of serverOnlyEnvironmentNames) {
    const value = process.env[name];
    if (value && text.includes(value)) {
      fail(`SECRET LEAK: ${file.relative} contains configured ${name}`);
    }
  }
}

const netlifyConfig = readFileSync(netlifyConfigPath, 'utf8');
const requiredHeaders = [
  ['Content-Security-Policy', /Content-Security-Policy\s*=\s*"[^"]*default-src 'self'/],
  ['Referrer-Policy', /Referrer-Policy\s*=\s*"no-referrer"/],
  ['X-Content-Type-Options', /X-Content-Type-Options\s*=\s*"nosniff"/],
];
const missingHeader = requiredHeaders.find(([, pattern]) => !pattern.test(netlifyConfig));
if (missingHeader) fail(`DEPLOYMENT HEADER CHECK FAILED: missing ${missingHeader[0]}`);

const serviceWorkerPath = resolve(dist, 'sw.js');
if (!statSync(serviceWorkerPath, { throwIfNoEntry: false })?.isFile()) {
  fail('SERVICE WORKER CACHE CHECK FAILED: dist/sw.js is missing');
}
const serviceWorker = readFileSync(serviceWorkerPath, 'utf8');
const requiredPublicEntries = ['index.html', 'assets/', 'icons/icon-192.png', 'icons/icon-512.png'];
const missingPublicEntry = requiredPublicEntries.find((entry) => !serviceWorker.includes(entry));
const privateEntry = ['manifest.webmanifest', '/api/', 'supabase'].find((entry) => serviceWorker.includes(entry));
if (missingPublicEntry || privateEntry) {
  fail(`SERVICE WORKER CACHE CHECK FAILED: ${missingPublicEntry ? `missing ${missingPublicEntry}` : `contains ${privateEntry}`}`);
}

console.log('Build looks safe (no detected static secrets)');
