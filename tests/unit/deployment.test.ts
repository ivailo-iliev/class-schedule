import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const netlify = readFileSync(resolve(root, 'netlify.toml'), 'utf8');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const vite = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
const accessFunction = readFileSync(resolve(root, 'netlify/functions/access.mjs'), 'utf8');

function position(text: string, value: string): number {
  return text.indexOf(value);
}

describe('Netlify deployment boundaries', () => {
  test('builds with Node 24 and the expected publish/function directories', () => {
    expect(netlify).toMatch(/command\s*=\s*"npm run build"/);
    expect(netlify).toMatch(/publish\s*=\s*"dist"/);
    expect(netlify).toMatch(/functions\s*=\s*"netlify\/functions"/);
    expect(netlify).toMatch(/NODE_VERSION\s*=\s*"24"/);
  });

  test('protects static content, serves the static manifest, and keeps SPA fallback last', () => {
    expect(netlify).toMatch(/Content-Security-Policy\s*=\s*"[^"]+"/);
    expect(netlify).toMatch(/Referrer-Policy\s*=\s*"no-referrer"/);
    expect(netlify).toMatch(/X-Content-Type-Options\s*=\s*"nosniff"/);
    expect(index).toMatch(/rel="manifest" href="\/manifest\.webmanifest"/);
    expect(netlify).toMatch(/for = "\/manifest\.webmanifest"/);
    expect(netlify).not.toMatch(/\.netlify\/functions\/(manifest|health|profile)/);
    expect(position(netlify, 'from = "/api/access"')).toBeLessThan(position(netlify, 'from = "/api/*"'));
    expect(position(netlify, 'from = "/api/*"')).toBeLessThan(position(netlify, 'from = "/*"'));
    expect(netlify).toMatch(/to\s*=\s*"\/index\.html"[\s\S]*status\s*=\s*200/);
  });

  test('retains only the access function route among application functions', () => {
    expect(netlify).toMatch(/from = "\/api\/access"[\s\S]*to = "\/.netlify\/functions\/access"/);
    expect(accessFunction).not.toMatch(/path:\s*['"]\/api\/access['"]/);
    expect(netlify).not.toMatch(/\/api\/(health|profile)/);
  });

  test('does not configure service workers, Workbox, or offline caching', () => {
    expect(vite).not.toMatch(/VitePWA|workbox|serviceWorker|registerSW|runtimeCaching|cacheName/i);
  });

  test('returns unknown API routes as 404 before the SPA fallback', () => {
    const apiNotFound = position(netlify, 'from = "/api/*"');
    const spaFallback = position(netlify, 'from = "/*"');
    expect(apiNotFound).toBeGreaterThanOrEqual(0);
    expect(apiNotFound).toBeLessThan(spaFallback);
    expect(netlify.slice(apiNotFound, spaFallback)).toMatch(/status = 404/);
  });
});
