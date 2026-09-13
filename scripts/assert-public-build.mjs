import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('PUBLIC BUILD CHECK: dist directory is missing');
  process.exit(1);
}

const prohibited = [
  'SUPABASE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'PRIVATE_KEY',
  'sb_secret_',
  'ENCRYPTION_KEY',
  'access_token_hash',
  '__Host-install=',
];

for (const entry of readdirSync(dist, { recursive: true })) {
  const file = resolve(dist, entry);
  if (!statSync(file).isFile() || !file.endsWith('.js')) continue;
  const text = readFileSync(file, 'utf8');
  const leaked = prohibited.find((needle) => text.includes(needle));
  if (leaked || entry.startsWith('.keys/')) {
    console.error(`SECRET LEAK: ${entry} contains prohibited string${leaked ? ` ${leaked}` : ''}`);
    process.exit(1);
  }
}

const serviceWorkerPath = resolve(dist, 'sw.js');
const serviceWorker = readFileSync(serviceWorkerPath, 'utf8');
const requiredPublicEntries = ['index.html', 'assets/', 'icons/icon-192.png', 'icons/icon-512.png'];
const missingPublicEntry = requiredPublicEntries.find((entry) => !serviceWorker.includes(entry));
const privateEntry = ['manifest.webmanifest', '/api/', 'supabase'].find((entry) => serviceWorker.includes(entry));
if (missingPublicEntry || privateEntry) {
  console.error(`SERVICE WORKER CACHE CHECK FAILED: ${missingPublicEntry ? `missing ${missingPublicEntry}` : `contains ${privateEntry}`}`);
  process.exit(1);
}

console.log('Build looks safe (no detected static secrets)');
