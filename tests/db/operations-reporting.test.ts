import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';
import { db } from './helpers';

const DOCS = resolve(process.env.OPERATIONS_DOC_PATH ?? resolve(process.cwd(), 'docs/operations.md'));
const T1 = '91000000-0000-4000-8000-000000000001';
const T2 = '91000000-0000-4000-8000-000000000002';
const C1 = '91000000-0000-4000-8000-000000000011';
const C2 = '91000000-0000-4000-8000-000000000012';
const C3 = '91000000-0000-4000-8000-000000000013';
const CLASSES = new Set([C1, C2, C3]);
const id = (n: number) => `91000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const U = {
  prior: id(101), start: id(102), startNext: id(103), endPrior: id(104), end: id(105), endNext: id(106),
  same1: id(107), same2: id(108), same3: id(109),
};
const X = { beforeStart: id(201), atStart: id(202), beforeEnd: id(203), atEnd: id(204), same2: id(205), same3: id(206) };

function documentedSql(heading: string): string {
  const text = readFileSync(DOCS, 'utf8');
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start < 0) throw new Error(`Missing documentation section: ${heading}`);
  const next = text.indexOf('\n## ', start + marker.length);
  const section = text.slice(start, next < 0 ? text.length : next);
  const match = section.match(/```sql\s*\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`Missing SQL block inside section: ${heading}`);
  const sql = match[1];
  for (const placeholder of [':start_date', ':end_date']) {
    if (!sql.includes(placeholder)) throw new Error(`Missing ${placeholder} placeholder: ${heading}`);
  }
  const bound = sql.replaceAll(':start_date', '$1').replaceAll(':end_date', '$2');
  if (bound.includes(':start_date') || bound.includes(':end_date')) {
    throw new Error(`Unbound period placeholder: ${heading}`);
  }
  return bound;
}

async function rollbackFixture(run: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await db();
  try {
    await client.query('BEGIN');
    try {
      await seed(client);
      await run(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

async function seed(client: PoolClient): Promise<void> {
  await client.query(
    `insert into public.profiles (id, name, role, active, access_token_hash) values
       ($1, 'Mutation Twin', 'teacher', true, $2),
       ($3, 'Mutation Twin', 'teacher', true, $4)`,
    [T1, '1'.repeat(64), T2, '2'.repeat(64)],
  );
  await client.query(
    `insert into public.classes (id, teacher_id, name, active) values
       ($1, $2, 'Mutation Class', true),
       ($3, $2, 'Mutation Class', true),
       ($4, $5, 'Mutation Class', true)`,
    [C1, T1, C2, C3, T2],
  );

  // Valid hourly, uncancelled rows go through the ordinary guard.
  const active: Array<[string, string, string, string]> = [
    [U.prior, C1, 'room_1', '2026-08-31 23:00'],
    [U.start, C1, 'room_2', '2026-09-01 00:00'],
    [U.startNext, C1, 'room_1', '2026-09-01 01:00'],
    [U.endPrior, C3, 'room_2', '2026-09-30 23:00'],
    [U.end, C2, 'room_1', '2026-10-01 00:00'],
    [U.endNext, C3, 'room_2', '2026-10-01 01:00'],
    [U.same1, C1, 'room_1', '2026-09-10 10:00'],
    [U.same2, C2, 'room_1', '2026-09-10 11:00'],
    [U.same3, C3, 'room_1', '2026-09-10 12:00'],
  ];
  for (const [booking, klass, room, wall] of active) {
    await client.query(
      `insert into public.bookings (id, class_id, room, starts_at)
       values ($1, $2, $3, $4::timestamp at time zone 'Europe/Sofia')`,
      [booking, klass, room, wall],
    );
  }

  const cancelled: Array<[string, string, string, string, string]> = [
    // In-window start but cancellation immediately before September: excluded from cancellation totals.
    [X.beforeStart, C1, 'room_1', '2026-09-05 09:00', '2026-08-31 23:59:59.999999'],
    // Out-of-window start, cancellation exactly at September start: included.
    [X.atStart, C1, 'room_1', '2026-08-20 09:00', '2026-09-01 00:00'],
    // Out-of-window start, cancellation immediately before October: included.
    [X.beforeEnd, C1, 'room_1', '2026-10-20 09:00', '2026-09-30 23:59:59.999999'],
    // In-window start, cancellation exactly at October start: excluded from cancellation totals.
    [X.atEnd, C1, 'room_1', '2026-09-06 09:00', '2026-10-01 00:00'],
    [X.same2, C2, 'room_1', '2026-08-21 09:00', '2026-09-15 12:00'],
    [X.same3, C3, 'room_1', '2026-10-21 09:00', '2026-09-16 12:00'],
  ];
  for (const [booking, klass, room, wall] of cancelled) {
    await client.query(
      `insert into public.bookings (id, class_id, room, starts_at)
       values ($1, $2, $3, $4::timestamp at time zone 'Europe/Sofia')`,
      [booking, klass, room, wall],
    );
  }
  // The guard intentionally stamps current cancellation time. Historical fixture times require
  // a transaction-local trigger bypass; ALTER plus the final ROLLBACK restores it even on failure.
  await client.query('alter table public.bookings disable trigger bookings_guard');
  try {
    for (const [booking, , , , cancelledWall] of cancelled) {
      await client.query(
        `update public.bookings set cancelled_at = $2::timestamp at time zone 'Europe/Sofia'
         where id = $1`,
        [booking, cancelledWall],
      );
    }
  } finally {
    await client.query('alter table public.bookings enable trigger bookings_guard');
  }
}

type Usage = { teacher_id: string; teacher: string; class_id: string; class: string; room: string; month: string; uncancelled_hours: number };
type Cancellation = { teacher_id: string; teacher: string; class_id: string; class: string; room: string; cancelled_hours: number };
type ExportRow = { id: string; teacher_id: string; class_id: string; room: string; local_start: string; local_cancelled: string | null };

const expectedSeptemberUsage: Usage[] = [
  [T1, C1, 'room_1', 2], [T1, C1, 'room_2', 1], [T1, C2, 'room_1', 1],
  [T2, C3, 'room_1', 1], [T2, C3, 'room_2', 1],
].map(([teacher_id, class_id, room, uncancelled_hours]) => ({
  teacher_id: String(teacher_id), teacher: 'Mutation Twin', class_id: String(class_id), class: 'Mutation Class',
  room: String(room), month: '2026-09-01', uncancelled_hours: Number(uncancelled_hours),
}));

const expectedWideUsage: Usage[] = [
  { teacher_id: T1, class_id: C1, room: 'room_1', month: '2026-08-01', uncancelled_hours: 1 },
  ...expectedSeptemberUsage,
  { teacher_id: T1, class_id: C2, room: 'room_1', month: '2026-10-01', uncancelled_hours: 1 },
  { teacher_id: T2, class_id: C3, room: 'room_2', month: '2026-10-01', uncancelled_hours: 1 },
].map((row) => ({ teacher: 'Mutation Twin', class: 'Mutation Class', ...row }));

const expectedCancellation: Cancellation[] = [
  [T1, C1, 2], [T1, C2, 1], [T2, C3, 1],
].map(([teacher_id, class_id, cancelled_hours]) => ({
  teacher_id: String(teacher_id), teacher: 'Mutation Twin', class_id: String(class_id), class: 'Mutation Class',
  room: 'room_1', cancelled_hours: Number(cancelled_hours),
}));

function usage(rows: Record<string, unknown>[]): Usage[] {
  return rows.filter((row) => CLASSES.has(String(row.class_id))).map((row) => ({
    teacher_id: String(row.teacher_id), teacher: String(row.teacher), class_id: String(row.class_id), class: String(row.class),
    room: String(row.room), month: String(row.month), uncancelled_hours: Number(row.uncancelled_hours),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function cancellations(rows: Record<string, unknown>[]): Cancellation[] {
  return rows.filter((row) => CLASSES.has(String(row.class_id))).map((row) => ({
    teacher_id: String(row.teacher_id), teacher: String(row.teacher), class_id: String(row.class_id), class: String(row.class),
    room: String(row.room), cancelled_hours: Number(row.cancelled_hours),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function local(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date) {
    // pg parses timestamp without time zone as a Date using the process timezone.
    // Local getters recover the original wall-clock value in any process timezone.
    const pad = (part: number, width = 2) => String(part).padStart(width, '0');
    return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
      + ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value).replace('T', ' ').replace('.000Z', '').replace('Z', '');
}
function exports(rows: Record<string, unknown>[]): ExportRow[] {
  return rows.filter((row) => String(row.id).startsWith('91000000-')).map((row) => ({
    id: String(row.id), teacher_id: String(row.teacher_id), class_id: String(row.class_id), room: String(row.room),
    local_start: local(row.local_start)!, local_cancelled: local(row.local_cancelled),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

async function executeForZone(client: PoolClient, zone: string) {
  await client.query(`set local time zone '${zone}'`);
  const monthly = documentedSql('Monthly usage report');
  const cancelled = documentedSql('Cancelled hours (reported separately)');
  const exportSql = documentedSql('Export all bookings for a period (CSV)');
  return {
    september: usage((await client.query(monthly, ['2026-09-01', '2026-10-01'])).rows),
    wide: usage((await client.query(monthly, ['2026-08-01', '2026-11-01'])).rows),
    cancelled: cancellations((await client.query(cancelled, ['2026-09-01', '2026-10-01'])).rows),
    exported: exports((await client.query(exportSql, ['2026-09-01', '2026-10-01'])).rows),
  };
}

describe('documented operations reporting SQL', () => {
  test('uses exact Sofia start-inclusive/end-exclusive bounds and stable identity groups in both session zones', async () => {
    await rollbackFixture(async (client) => {
      const utc = await executeForZone(client, 'UTC');
      const ny = await executeForZone(client, 'America/New_York');
      const sortedSeptember = [...expectedSeptemberUsage].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const sortedWide = [...expectedWideUsage].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const sortedCancelled = [...expectedCancellation].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      for (const result of [utc, ny]) {
        expect(result.september).toEqual(sortedSeptember);
        expect(result.wide).toEqual(sortedWide);
        expect(result.cancelled).toEqual(sortedCancelled);
        expect(result.cancelled.every((row) => !('month' in row))).toBe(true);
      }
      expect(ny).toEqual(utc);
    });
  });

  test('exports exactly September starts, retains cancellation history, and excludes cancelled rows from usage', async () => {
    await rollbackFixture(async (client) => {
      const utc = await executeForZone(client, 'UTC');
      const ny = await executeForZone(client, 'America/New_York');
      const expectedIds = [U.start, U.startNext, U.endPrior, U.same1, U.same2, U.same3, X.beforeStart, X.atEnd].sort();
      expect(utc.exported.map((row) => row.id)).toEqual(expectedIds);
      expect(utc.exported.find((row) => row.id === U.start)?.local_start).toContain('2026-09-01');
      expect(utc.exported.find((row) => row.id === X.beforeStart)?.local_cancelled).toContain('2026-08-31');
      expect(utc.exported.find((row) => row.id === X.atEnd)?.local_cancelled).toContain('2026-10-01');
      expect(utc.september.reduce((sum, row) => sum + row.uncancelled_hours, 0)).toBe(6);
      expect(utc.exported.filter((row) => row.local_cancelled !== null).map((row) => row.id).sort())
        .toEqual([X.beforeStart, X.atEnd].sort());
      expect(ny.exported).toEqual(utc.exported);
    });
  });
});
