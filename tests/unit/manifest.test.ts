import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(root, 'public/manifest.webmanifest');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');

describe('static web manifest', () => {
  test('contains only public standalone app metadata and existing icons', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: 'График на класовете',
      short_name: 'График',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#1f2937',
    });
    expect(manifest.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/token|profile|session|cookie|credential/i);
  });

  test('is referenced statically by the document', () => {
    expect(index).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"\s*\/>/);
    expect(index).not.toMatch(/manifest\.webmanifest\?/);
  });
});
