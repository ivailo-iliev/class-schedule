import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { FullConfig } from '@playwright/test';

export type E2EProfile = {
  id: string;
  token: string;
  classId: string;
};

export type E2EState = {
  apiUrl: string;
  publishableKey: string;
  sets: Record<string, { teacherA: E2EProfile; teacherB: E2EProfile; admin: E2EProfile; day: string; nextDay: string }>;
};

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

function profile(name: string, role: 'teacher' | 'admin'): E2EProfile & { name: string; role: string; hash: string } {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  return { id, token, classId: randomUUID(), name, role, hash: createHash('sha256').update(token).digest('hex') };
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const env = localEnv();
  const pool = new pg.Pool({ connectionString: env.DB_URL, statement_timeout: 10_000 });
  const sets: E2EState['sets'] = {};
  const client = await pool.connect();
  try {
    for (const project of ['chromium', 'webkit']) {
      const teacherA = profile(`E2E ${project} Teacher A`, 'teacher');
      const teacherB = profile(`E2E ${project} Teacher B`, 'teacher');
      const admin = profile(`E2E ${project} Admin`, 'admin');
      const day = project === 'chromium' ? '2027-09-15' : '2028-09-15';
      const nextDay = project === 'chromium' ? '2027-09-16' : '2028-09-16';
      sets[project] = { teacherA, teacherB, admin, day, nextDay };
      const profiles = [teacherA, teacherB, admin];
      await client.query('BEGIN');
      for (const item of profiles) {
        await client.query(
          `insert into public.profiles (id, name, role, active, access_token_hash)
           values ($1, $2, $3::public.app_role, true, $4)`,
          [item.id, item.name, item.role, item.hash],
        );
      }
      await client.query(
        `insert into public.classes (id, teacher_id, name, active)
         values ($1, $2, $3, true), ($4, $5, $6, true)`,
        [teacherA.classId, teacherA.id, `${project} A Class`, teacherB.classId, teacherB.id, `${project} B Class`],
      );
      await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ($3::date + make_time(9, 0, 0)) at time zone 'Europe/Sofia'),
                ($2, 'room_2', ($3::date + make_time(10, 0, 0)) at time zone 'Europe/Sofia')`,
        [teacherA.classId, teacherB.classId, day],
      );
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    apiUrl: env.API_URL,
    publishableKey: env.PUBLISHABLE_KEY,
    sets,
  } satisfies E2EState), 'utf8');
}
