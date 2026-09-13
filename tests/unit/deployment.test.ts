import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const netlify = readFileSync(resolve(root, 'netlify.toml'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const accessFunction = readFileSync(resolve(root, 'netlify/functions/access.mjs'), 'utf8');
const manifestFunction = readFileSync(resolve(root, 'netlify/functions/manifest.mjs'), 'utf8');

describe('Netlify deployment boundaries', () => {
  test('builds with Node 24 and the expected publish/function directories', () => {
    expect(netlify).toMatch(/command\s*=\s*"npm run build"/);
    expect(netlify).toMatch(/publish\s*=\s*"dist"/);
    expect(netlify).toMatch(/functions\s*=\s*"netlify\/functions"/);
    expect(netlify).toMatch(/NODE_VERSION\s*=\s*"24"/);
  });

  test('protects static content and keeps the SPA fallback last', () => {
    expect(netlify).toMatch(/Content-Security-Policy\s*=\s*"[^"]+"/);
    expect(netlify).toMatch(/Referrer-Policy\s*=\s*"no-referrer"/);
    expect(netlify).toMatch(/X-Content-Type-Options\s*=\s*"nosniff"/);
    expect(netlify.indexOf('from = "/*"')).toBeGreaterThan(netlify.indexOf('from = "/manifest.webmanifest"'));
    expect(netlify).toMatch(/to\s*=\s*"\/index\.html"[\s\S]*status\s*=\s*200/);
  });

  test('routes public endpoints to their default function URLs before the API fallback', () => {
    const accessRedirect = netlify.indexOf('from = "/api/access"');
    const manifestRedirect = netlify.indexOf('from = "/manifest.webmanifest"');
    const healthRedirect = netlify.indexOf('from = "/api/health"');
    const apiFallback = netlify.indexOf('from = "/api/*"');

    expect(netlify).toMatch(/from = "\/api\/access"[\s\S]*to = "\/.netlify\/functions\/access"/);
    expect(netlify).toMatch(/from = "\/manifest\.webmanifest"[\s\S]*to = "\/.netlify\/functions\/manifest"/);
    expect(netlify).toMatch(/from = "\/api\/health"[\s\S]*to = "\/.netlify\/functions\/health"/);
    expect(accessRedirect).toBeLessThan(apiFallback);
    expect(manifestRedirect).toBeLessThan(apiFallback);
    expect(healthRedirect).toBeLessThan(apiFallback);
    expect(accessFunction).not.toMatch(/path:\s*['"]\/api\/access['"]/);
    expect(manifestFunction).not.toMatch(/path:\s*['"]\/manifest\.webmanifest['"]/);
  });

  test('documents separate public build and function-only variables', () => {
    expect(envExample).toMatch(/VITE_SUPABASE_URL=/);
    expect(envExample).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY=/);
    expect(envExample).toMatch(/SUPABASE_SECRET_API_KEY=/);
    expect(envExample).not.toMatch(/SIGNING_JWK|SUPABASE_JWKS_URL|SUPABASE_SECRET_KEY/);
  });
});
