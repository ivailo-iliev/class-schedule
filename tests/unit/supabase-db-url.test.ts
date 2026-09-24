import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { normalizeSupabaseDbUrl } from '../../scripts/normalize-supabase-db-url.mjs';

const root = resolve(import.meta.dirname, '../..');
const ciWorkflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

describe('Supabase CI database URL normalization', () => {
  test('accepts the quoted DB_URL emitted by supabase status --output env', () => {
    expect(
      normalizeSupabaseDbUrl('"postgresql://postgres:secret@base:54322/postgres"'),
    ).toBe('postgresql://postgres:secret@127.0.0.1:54322/postgres');
  });

  test('also accepts an unquoted URL and always uses the published host port', () => {
    expect(
      normalizeSupabaseDbUrl('postgresql://postgres:secret@db.internal:54322/postgres'),
    ).toBe('postgresql://postgres:secret@127.0.0.1:54322/postgres');
  });

  test('wires the helper into the integration workflow', () => {
    expect(ciWorkflow).toContain('node scripts/normalize-supabase-db-url.mjs "$raw_db_url"');
  });

  test('rejects missing or malformed database URLs', () => {
    expect(() => normalizeSupabaseDbUrl('')).toThrow('database URL');
    expect(() => normalizeSupabaseDbUrl('"not a URL"')).toThrow('database URL');
  });
});
