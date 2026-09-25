import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const netlify = readFileSync(resolve(root, 'netlify.toml'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const accessFunction = readFileSync(resolve(root, 'netlify/functions/access.mjs'), 'utf8');

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
    expect(netlify.indexOf('from = "/*"')).toBeGreaterThan(netlify.indexOf('from = "/api/*"'));
    expect(netlify).toMatch(/to\s*=\s*"\/index\.html"[\s\S]*status\s*=\s*200/);
  });

  test('keeps only access and health function routes before the API fallback', () => {
    const accessRedirect = netlify.indexOf('from = "/api/access"');
    const healthRedirect = netlify.indexOf('from = "/api/health"');
    const apiFallback = netlify.indexOf('from = "/api/*"');

    expect(netlify).toMatch(/from = "\/api\/access"[\s\S]*to = "\/.netlify\/functions\/access"/);
    expect(netlify).toMatch(/from = "\/api\/health"[\s\S]*to = "\/.netlify\/functions\/health"/);
    expect(accessRedirect).toBeLessThan(apiFallback);
    expect(healthRedirect).toBeLessThan(apiFallback);
    expect(accessFunction).not.toMatch(/path:\s*['"]\/api\/access['"]/);
    expect(netlify).not.toMatch(/manifest\.webmanifest|functions\.manifest|\.netlify\/functions\/manifest|__Host-install/);
    expect(existsSync(resolve(root, 'netlify/functions/manifest.mjs'))).toBe(false);
    expect(existsSync(resolve(root, 'netlify/lib/manifest.mjs'))).toBe(false);
    expect(netlify).not.toMatch(/\/api\/profile|functions\.profile|\.netlify\/functions\/profile/);
  });

  test('returns unknown API routes as 404 before the SPA fallback', () => {
    const apiNotFound = netlify.indexOf('from = "/api/*"');
    const spaFallback = netlify.indexOf('from = "/*"');

    expect(apiNotFound).toBeGreaterThanOrEqual(0);
    expect(apiNotFound).toBeLessThan(spaFallback);
    expect(netlify.slice(apiNotFound, spaFallback)).toMatch(/status = 404/);
  });

  test('documents separate public build and function-only variables', () => {
    expect(envExample).toMatch(/VITE_SUPABASE_URL=/);
    expect(envExample).toMatch(/VITE_SUPABASE_PUBLISHABLE_KEY=/);
    expect(envExample).toMatch(/SUPABASE_SECRET_API_KEY=/);
    expect(envExample).not.toMatch(/SIGNING_JWK|SUPABASE_JWKS_URL|SUPABASE_SECRET_KEY/);
  });
});
