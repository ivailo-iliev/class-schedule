import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
mkdirSync(dist, { recursive: true });

// Keep static-host headers available for deploys that do not apply the TOML
// rules to generated files. Private function responses set their own no-store
// headers and are also covered by netlify.toml.
const headers = `/*
  Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.supabase.co; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; manifest-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none';
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), sync-xhr=()

/api/*
  Cache-Control: private, no-store
  X-Content-Type-Options: nosniff

/manifest.webmanifest
  Cache-Control: private, no-store
  Netlify-CDN-Cache-Control: no-store
  Vary: Cookie
`;

writeFileSync(resolve(dist, '_headers'), headers, 'utf8');
console.log('Deployment headers written to dist/_headers');
