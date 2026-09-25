import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { FullConfig } from '@playwright/test';

export type E2EProfile = {
  id: string;
  token: string;
  classId?: string;
};

export type E2ESet = {
  teacherA: E2EProfile;
  teacherB: E2EProfile;
  admin: E2EProfile;
  day: string;
  nextDay: string;
  bookingAId: string;
  bookingBId: string;
};

export type E2EState = {
  apiUrl: string;
  publishableKey: string;
  sets: Record<string, E2ESet>;
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
    .map((match) => [match[1]!, match[2].replace(/^"|"$/g, '')]));
}

function profile(name: string, role: 'teacher' | 'admin'): E2EProfile & { name: string; role: string; hash: string } {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  return { id, token, classId: role === 'teacher' ? randomUUID() : undefined, name, role, hash: createHash('sha256').update(token).digest('hex') };
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
      await client.query('BEGIN');
      await client.query(
        `insert into public.profiles (id, name, role, active, access_token_hash)
         values ($1, $2, $3::public.app_role, true, $4),
                ($5, $6, $7::public.app_role, true, $8),
                ($9, $10, $11::public.app_role, true, $12)`,
        [teacherA.id, teacherA.name, teacherA.role, teacherA.hash, teacherB.id, teacherB.name, teacherB.role, teacherB.hash, admin.id, admin.name, admin.role, admin.hash],
      );
      await client.query(
        `insert into public.classes (id, teacher_id, name, active)
         values ($1, $2, $3, true), ($4, $5, $6, true)`,
        [teacherA.classId, teacherA.id, `${project} A Class`, teacherB.classId, teacherB.id, `${project} B Class`],
      );
      const bookings = await client.query<{ id: string }>(
        `insert into public.bookings (class_id, room, starts_at, ends_at, student_details, calculated_amount, price_breakdown)
         values ($1, 'hall', $3::timestamp, $4::timestamp, 'A private detail', 10, '[]'::jsonb),
                ($2, 'room', $5::timestamp, $6::timestamp, 'B private detail', 5, '[]'::jsonb)
         returning id`,
        [teacherA.classId, teacherB.classId, `${day}T09:00:00`, `${day}T10:00:00`, `${day}T10:00:00`, `${day}T10:30:00`],
      );
      await client.query('COMMIT');
      sets[project] = {
        teacherA,
        teacherB,
        admin,
        day,
        nextDay,
        bookingAId: bookings.rows[0]!.id,
        bookingBId: bookings.rows[1]!.id,
      };
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
