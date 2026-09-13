import { describe, test, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, asAuthenticated } from './helpers';

function documentedSql(heading: string): string {
  const text = readFileSync(resolve(process.cwd(), 'docs/operations.md'), 'utf8');
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`Missing documentation section: ${heading}`);
  const block = text.slice(start).match(/```sql\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error(`Missing SQL code block: ${heading}`);
  if (!block.includes(':start_date') || !block.includes(':end_date')) {
    throw new Error(`Missing period placeholders: ${heading}`);
  }
  return block.replaceAll(':start_date', '$1').replaceAll(':end_date', '$2');
}

// Seed fixtures (supabase/seed.sql) provide:
//   Teacher A 11111111-... owns class aaaaaaaa-... 'Morning Yoga' (room_1)
//   Teacher B 22222222-... owns class bbbbbbbb-... 'Evening Pilates' (room_2)
//   Booking on 2026-09-15 09:00 room_1 (Morning Yoga)
//   Booking on 2026-09-15 10:00 room_2 (Evening Pilates)
//   annual_rates row for 2026 = 20.00 BGN
const CLAIMS_A = {
  sub: '11111111-1111-1111-1111-111111111111',
  role: 'authenticated',
  app: 'class-scheduler-v1',
  credential_version: 1,
};
const CLAIMS_B = {
  sub: '22222222-2222-2222-2222-222222222222',
  role: 'authenticated',
  app: 'class-scheduler-v1',
  credential_version: 1,
};

// Dedicated billing fixtures so they never collide with seed or other suites.
const B_P = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; // billing teacher
const B_C = 'dddddddd-dddd-dddd-dddd-cccccccccccc'; // billing class
const B_ROOM1_1 = 'dddddddd-dddd-0001-0001-000000000001';
const B_ROOM1_2 = 'dddddddd-dddd-0001-0002-000000000002';
const B_ROOM2_1 = 'dddddddd-dddd-0002-0001-000000000003';
const B_ROOM1_C = 'dddddddd-dddd-0001-000c-00000000000c';
const B_ROOM1_2027 = 'dddddddd-dddd-0001-2027-000000000020';
// Isolated booking for the cancellation-history read test (own teacher/room).
const CANCEL_T = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CANCEL_C = 'eeeeeeee-eeee-eeee-eeee-cccccccccccc';
const CANCEL_B = 'eeeeeeee-eeee-0001-eeee-0000000000e1';

function parse(jsonb: unknown): any {
  return typeof jsonb === 'string' ? JSON.parse(jsonb) : jsonb;
}

async function ensureBillingFixtures() {
  const c = await db();
  try {
    await c.query(
      `insert into public.profiles (id, name, role, active, access_token_hash)
       values ($1, 'Billing Teacher', 'teacher', true,
         'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
       on conflict (id) do nothing`,
      [B_P]);
    await c.query(
      `insert into public.classes (id, teacher_id, name, active)
       values ($1, $2, 'Billing Class', true)
       on conflict (id) do nothing`,
      [B_C, B_P]);
    // Explicit ids + ON CONFLICT(id) DO NOTHING so repeated calls don't dup.
    // The 09-30 row is inserted uncancelled; the booking_guard trigger forbids
    // a non-null cancelled_at on INSERT, so we cancel it via the RPC below.
    await c.query(
      `insert into public.bookings (id, class_id, room, starts_at)
       values
         ($1, $5, 'room_1', (date '2026-09-10' + make_time(9,0,0)) at time zone 'Europe/Sofia'),
         ($2, $5, 'room_1', (date '2026-09-20' + make_time(10,0,0)) at time zone 'Europe/Sofia'),
         ($3, $5, 'room_2', (date '2026-09-15' + make_time(11,0,0)) at time zone 'Europe/Sofia'),
         ($4, $5, 'room_1', (date '2026-09-30' + make_time(23,0,0)) at time zone 'Europe/Sofia')
       on conflict (id) do nothing`,
      [B_ROOM1_1, B_ROOM1_2, B_ROOM2_1, B_ROOM1_C, B_C]);
    // 2027-01: one uncancelled hour, but NO annual_rates row for 2027.
    await c.query(
      `insert into public.bookings (id, class_id, room, starts_at)
       values ($1, $2, 'room_1', (date '2027-01-12' + make_time(8,0,0)) at time zone 'Europe/Sofia')
       on conflict (id) do nothing`,
      [B_ROOM1_2027, B_C]);
  } finally {
    c.release();
  }
  // Cancel the 09-30 row through the proper RPC as its owner (billing teacher),
  // so the SECURITY INVOKER check resolves a real actor instead of postgres.
  await asAuthenticated(
    { sub: B_P, role: 'authenticated', app: 'class-scheduler-v1',
      credential_version: 1 },
    async (client) => {
      await client.query(`select public.cancel_booking($1::uuid, 1)`, [B_ROOM1_C]);
    });
}

afterAll(async () => {
  const c = await db();
  try {
    await c.query('alter table public.bookings disable trigger bookings_guard');
    await c.query('delete from public.bookings where class_id in ($1,$2)', [B_C, CANCEL_C]);
    await c.query('alter table public.bookings enable trigger bookings_guard');
    await c.query('delete from public.classes where id in ($1,$2)', [B_C, CANCEL_C]);
    await c.query('delete from public.profiles where id in ($1,$2)', [B_P, CANCEL_T]);
  } finally {
    c.release();
  }
});

describe('daily schedule read via get_day', () => {

  test('get_day denies anonymous access', async () => {
    const client = await db();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE anon');
      try {
        await client.query('select public.get_day($1::date)', ['2026-09-15']);
        throw new Error('expected permission denied');
      } catch (e: any) {
        // anon lacks EXECUTE -> 42501 (permission_denied)
        expect(e.code).toBe('42501');
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  test('get_day returns occupied bookings for both rooms with local hour labels', async () => {
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows } = await client.query(
        'select public.get_day($1::date) as d', ['2026-09-15']);
      const out = parse(rows[0].d);
      expect(out.date).toBe('2026-09-15');
      // 24 hourly slot labels, each with a validity flag.
      expect(out.slots.length).toBe(24);
      expect(out.slots.every((s: any) => s.hour >= 0 && s.hour <= 23)).toBe(true);
      expect(out.slots[9].valid).toBe(true);
      // Both seed bookings are visible to any authenticated actor.
      expect(out.bookings.length).toBe(2);
      const room1 = out.bookings.find((b: any) => b.room === 'room_1');
      const room2 = out.bookings.find((b: any) => b.room === 'room_2');
      expect(room1.class_name).toBe('Morning Yoga');
      expect(room1.teacher_name).toBe('Teacher A');
      expect(room1.hour).toBe(9);
      expect(room2.class_name).toBe('Evening Pilates');
      expect(room2.teacher_name).toBe('Teacher B');
      expect(room2.hour).toBe(10);
      // Owner of room_1 may edit; cross-teacher room_2 booking is read-only.
      expect(room1.can_edit).toBe(true);
      expect(room2.can_edit).toBe(false);
      expect(room1.cancelled_at).toBeNull();
      expect(room2.cancelled_at).toBeNull();
    });
  });

  test('get_day marks invalid DST wall-clock hours as not bookable', async () => {
    // Europe/Sofia spring-forward 2026-03-29: 03:00 does not exist.
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows } = await client.query(
        'select public.get_day($1::date) as d', ['2026-03-29']);
      const out = parse(rows[0].d);
      expect(out.slots.length).toBe(24);
      expect(out.slots[2].valid).toBe(true);   // 02:00 exists
      expect(out.slots[3].valid).toBe(false);  // 03:00 skipped
      expect(out.slots[4].valid).toBe(true);   // 04:00 exists
    });
  });

  test('get_day includes cancelled bookings as history, not occupying slots', async () => {
    // Isolated teacher/class/booking so the shared seed is never mutated.
    const c = await db();
    try {
      await c.query(
        `insert into public.profiles (id, name, role, active, access_token_hash)
         values ($1, 'Cancel Teacher', 'teacher', true,
           'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
         on conflict (id) do nothing`, [CANCEL_T]);
      await c.query(
        `insert into public.classes (id, teacher_id, name, active)
         values ($1, $2, 'Cancel Class', true)
         on conflict (id) do nothing`, [CANCEL_C, CANCEL_T]);
      await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ($1, $2, 'room_1', (date '2026-09-15' + make_time(14,0,0)) at time zone 'Europe/Sofia')
         on conflict (id) do nothing`, [CANCEL_B, CANCEL_C]);
    } finally {
      c.release();
    }
    await asAuthenticated(
      { sub: CANCEL_T, role: 'authenticated', app: 'class-scheduler-v1',
        credential_version: 1 },
      async (c) => {
        await c.query(`select public.cancel_booking($1::uuid, 1)`, [CANCEL_B]);
      });
    await asAuthenticated(CLAIMS_A, async (c) => {
      const { rows } = await c.query(
        'select public.get_day($1::date) as d', ['2026-09-15']);
      const out = parse(rows[0].d);
      const cancelled = out.bookings.find((b: any) => b.id === CANCEL_B);
      expect(cancelled).toBeTruthy();
      expect(cancelled.cancelled_at).not.toBeNull();
      expect(cancelled.can_edit).toBe(false);
    });
  });

});

describe('Supabase-only billing report (Appendix F SQL)', () => {

  test('executes the three documented period queries independent of session timezone', async () => {
    const queries = [
      documentedSql('Monthly usage report'),
      documentedSql('Cancelled hours (reported separately)'),
      documentedSql('Export all bookings for a period (CSV)'),
    ];
    const results: string[] = [];
    for (const zone of ['UTC', 'America/New_York']) {
      const c = await db();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL TIME ZONE '${zone}'`);
        for (const query of queries) {
          const result = await c.query(query, ['2026-09-01', '2026-10-01']);
          results.push(JSON.stringify(result.rows));
        }
        await c.query('ROLLBACK');
      } finally { c.release(); }
    }
    expect(results[0]).toBe(results[3]);
    expect(results[1]).toBe(results[4]);
    expect(results[2]).toBe(results[5]);
  });

  test('monthly usage groups by teacher/class/room and respects month boundaries', async () => {
    await ensureBillingFixtures();
    const c = await db();
    try {
      const { rows } = await c.query(`
        select p.name as teacher, c.name as class, b.room,
          to_char(date_trunc('month', b.starts_at at time zone 'Europe/Sofia'), 'YYYY-MM-DD') as month,
          count(b.id) as uncancelled_hours
        from public.bookings b
        join public.classes c on c.id = b.class_id
        join public.profiles p on p.id = c.teacher_id
        where b.cancelled_at is null
          and b.starts_at >= '2026-09-01'::date
          and b.starts_at <  '2026-10-01'::date
          and b.class_id = $1
        group by p.name, c.name, b.room, month
        order by b.room, month`, [B_C]);
      // Two room_1 (09-10, 09-20) + one room_2 (09-15); the 09-30 cancelled
      // row is excluded; the 2027 row is outside the month window.
      expect(rows.length).toBe(2);
      const r1 = rows.find((r: any) => r.room === 'room_1')!;
      const r2 = rows.find((r: any) => r.room === 'room_2')!;
      expect(Number(r1.uncancelled_hours)).toBe(2);
      expect(Number(r2.uncancelled_hours)).toBe(1);
      expect(r1.month).toBe('2026-09-01');
    } finally {
      c.release();
    }
  });

  test('cancelled hours are excluded from usage but reported separately', async () => {
    await ensureBillingFixtures();
    const c = await db();
    try {
      const { rows } = await c.query(`
        select count(b.id)::int as cancelled_hours
        from public.bookings b
        where b.cancelled_at is not null
          and b.starts_at >= '2026-09-01'::date
          and b.starts_at <  '2026-10-01'::date
          and b.class_id = $1`, [B_C]);
      expect(rows[0].cancelled_hours).toBe(1);
    } finally {
      c.release();
    }
  });

  test('annual rate is resolved for a configured year and missing for an unconfigured one', async () => {
    await ensureBillingFixtures();
    const c = await db();
    try {
      const r2026 = await c.query(
        `select room_hour_rate, currency from private.annual_rates where year = 2026`);
      expect(r2026.rows.length).toBe(1);
      expect(Number(r2026.rows[0].room_hour_rate)).toBe(20.00);
      expect(r2026.rows[0].currency).toBe('BGN');
      // 2027 has bookings but no annual_rates row: rate lookup is empty, so a
      // billed-total computation must surface a missing rate.
      const r2027 = await c.query(
        `select room_hour_rate from private.annual_rates where year = 2027`);
      expect(r2027.rows.length).toBe(0);
    } finally {
      c.release();
    }
  });

});
