import { basename } from 'node:path';

const scriptName = 'normalize-supabase-db-url.mjs';

export function normalizeSupabaseDbUrl(rawValue) {
  const raw = rawValue.trim();
  const quoted = raw.match(/^("|')(.*)\1$/s);
  const value = quoted ? quoted[2] : raw;

  if (!value) {
    throw new Error('A database URL is required');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid database URL: ${value}`);
  }

  url.hostname = '127.0.0.1';
  return url.toString();
}

if (basename(process.argv[1] ?? '') === scriptName) {
  const rawValue = process.argv[2];
  if (rawValue === undefined) {
    throw new Error('Usage: node scripts/normalize-supabase-db-url.mjs <DB_URL>');
  }
  process.stdout.write(normalizeSupabaseDbUrl(rawValue));
}
