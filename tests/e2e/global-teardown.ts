import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { FullConfig } from '@playwright/test';
import type { E2EState } from './global-setup';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const statePath = resolve(root, 'test-results/e2e-state.json');

function localEnv(): Record<string, string> {
  const output = execFileSync('supabase', ['status', '--output', 'env'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return Object.fromEntries(output.split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => [match[1]!, match[2]!.replace(/^"|"$/g, '')]));
}

async function deleteAuthUser(apiUrl: string, serviceKey: string, userId: string): Promise<void> {
  await fetch(`${apiUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
}

export default async function globalTeardown(_config: FullConfig): Promise<void> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as E2EState;
  const env = localEnv();
  const profiles = Object.values(state.sets).flatMap((set) => [set.teacherA, set.teacherB, set.admin]);
  const profileIds = profiles.map((item) => item.id);
  const classIds = profiles.filter((item) => item.classId).map((item) => item.classId);
  const pool = new pg.Pool({ connectionString: env.DB_URL, statement_timeout: 10_000 });
  const client = await pool.connect();
  let userIds: string[] = [];
  try {
    const users = await client.query<{ auth_user_id: string | null }>(
      'select auth_user_id from public.profiles where id = any($1::uuid[])', [profileIds],
    );
    userIds = users.rows.flatMap((row) => row.auth_user_id ? [row.auth_user_id] : []);
    await client.query('delete from public.bookings where class_id = any($1::uuid[])', [classIds]);
    await client.query('delete from public.classes where id = any($1::uuid[])', [classIds]);
    await client.query('delete from public.profiles where id = any($1::uuid[])', [profileIds]);
  } finally {
    client.release();
    await pool.end();
  }
  for (const userId of userIds) await deleteAuthUser(env.API_URL!, env.SERVICE_ROLE_KEY!, userId);
}
