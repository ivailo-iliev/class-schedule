import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const dist = resolve(root, 'dist');
const indexPath = resolve(root, 'index.html');
const manifestPath = resolve(dist, 'manifest.webmanifest');
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
  'SUPABASE_DB_URL',
  'SUPABASE_JWKS_URL',
  'SIGNING_JWK',
  'PRIVATE_KEY',
  'ENCRYPTION_KEY',
  'access_token_hash',
  'access_token_used_at',
  '__Host-install=',
  '/.netlify/functions/manifest',
  '/.netlify/functions/health',
  '/.netlify/functions/profile',
];
const credentialValuePatterns = [
  /(?:^|[^0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i,
  /(?:#|%23)[0-9a-f]{64}(?![0-9a-f])/i,
  /(?:[?&](?:token|profile)=)[^&\s"']+/i,
  /(?:Bearer\s+|Authorization:\s*)eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
];
const files = filesUnder(dist);
for (const file of files) {
  const text = readFileSync(file.absolute, 'utf8');
  const prohibited = prohibitedNames.find((needle) => text.includes(needle));
  const credentialValue = credentialValuePatterns.find((pattern) => pattern.test(text));
  if (prohibited || credentialValue || file.relative.startsWith('.keys/')) {
    fail(`SECRET LEAK: ${file.relative} contains prohibited public-build content`);
  }
  if (/navigator\.serviceWorker|\.register\(['"]\/sw|workbox-|CacheFirst|runtimeCaching|cacheName/i.test(text)) {
    fail(`OFFLINE FEATURE LEAK: ${file.relative} contains service-worker or cache code`);
  }
}

if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
  fail('STATIC MANIFEST CHECK FAILED: dist/manifest.webmanifest is missing');
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.start_url !== '/' || manifest.scope !== '/' || manifest.display !== 'standalone' ||
    !Array.isArray(manifest.icons) || manifest.icons.length !== 2) {
  fail('STATIC MANIFEST CHECK FAILED: invalid public manifest contract');
}
const index = readFileSync(indexPath, 'utf8');
if (!/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/>/.test(index)) {
  fail('STATIC MANIFEST CHECK FAILED: index.html does not reference the static manifest');
}
if (files.some(({ relative }) => /(?:^|\/)(?:sw|registerSW)\.js$/.test(relative))) {
  fail('OFFLINE FEATURE LEAK: built service-worker artifact exists');
}

const netlifyConfig = readFileSync(netlifyConfigPath, 'utf8');
const requiredHeaders = [
  ['Content-Security-Policy', /Content-Security-Policy\s*=\s*"[^"]*default-src 'self'/],
  ['Referrer-Policy', /Referrer-Policy\s*=\s*"no-referrer"/],
  ['X-Content-Type-Options', /X-Content-Type-Options\s*=\s*"nosniff"/],
];
const missingHeader = requiredHeaders.find(([, pattern]) => !pattern.test(netlifyConfig));
if (missingHeader) fail(`DEPLOYMENT HEADER CHECK FAILED: missing ${missingHeader[0]}`);

console.log('Build looks safe (static manifest, no detected credentials or offline artifacts)');
