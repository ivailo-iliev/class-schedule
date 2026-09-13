import { describe, test, expect, afterAll } from 'vitest';
import { db, asAuthenticated } from './helpers';

// Dedicated profiles for this suite so state does not collide with
// bookings.test.ts (7777...) or the shared seed fixtures (1111/2222/3333).
const R_A = '88888888-8888-8888-8888-888888888801'; // teacher, owner of class
const R_B = '88888888-8888-8888-8888-888888888802'; // other teacher
const R_ADM = '88888888-8888-8888-8888-888888888803'; // admin

const CLAIMS_A = {
  sub: R_A, role: 'authenticated',
  app: 'class-scheduler-v1', credential_version: 1,
};

// Stable class id owned by this suite's teacher.
const CLASS_A = '88888888-8888-8888-8888-aaaaaaaaaa01';

let setupDone = false;
async function ensureProfiles() {
  if (setupDone) return;
  const c = await db();
  try {
    await c.query(
      `insert into public.profiles (id, name, role, active, access_token_hash) values
        ($1, 'Rec Teacher', 'teacher', true,
          '8888888888888888888888888888888888888888888888888888888888888888'),
        ($2, 'Rec Other', 'teacher', true,
          '7777777777777777777777777777777777777777777777777777777777777777'),
        ($3, 'Rec Admin', 'admin', true,
          '9999999999999999999999999999999999999999999999999999999999999999')
      on conflict (id) do nothing`,
      [R_A, R_B, R_ADM],
    );
    await c.query(
      `insert into public.classes (id, teacher_id, name, active) values
        ($1, $2, 'Rec Class A', true)
      on conflict (id) do nothing`,
      [CLASS_A, R_A],
    );
    setupDone = true;
  } finally {
    c.release();
  }
}

afterAll(async () => {
  const c = await db();
  try {
    await c.query('alter table public.profiles disable trigger profiles_guard');
    await c.query('alter table public.bookings disable trigger bookings_guard');
    await c.query('alter table public.classes disable trigger classes_guard');
    await c.query(
      `delete from public.bookings where class_id in (
         select id from public.classes where teacher_id = any($1))`,
      [[R_A, R_B, R_ADM]],
    );
    await c.query('delete from public.classes where teacher_id = any($1)', [[R_A, R_B, R_ADM]]);
    await c.query('delete from public.profiles where id = any($1)', [[R_A, R_B, R_ADM]]);
    await c.query('alter table public.classes enable trigger classes_guard');
    await c.query('alter table public.bookings enable trigger bookings_guard');
    await c.query('alter table public.profiles enable trigger profiles_guard');
  } finally {
    c.release();
  }
});

function sofia(date: string, hour: number): string {
  return `((date '${date}' + make_time(${hour},0,0)) at time zone 'Europe/Sofia')`;
}

describe('one-off booking creation (N=1)', () => {

  test('one-off creates one owned concrete booking', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows } = await client.query(
        `select * from public.schedule_bookings($1::uuid, $2::public.room, $3::date, $4::int, 1, null)`,
        [CLASS_A, 'room_1', '2026-10-05', 17],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].room).toBe('room_1');
      expect(rows[0].class_id).toBe(CLASS_A);
      expect(Number(rows[0].version)).toBe(1);
      expect(rows[0].created_by).toBe(R_A);
      // The stored instant must equal the Sofia hour, not a shifted UTC value.
      const { rows: chk } = await client.query(
        `select starts_at = ${sofia('2026-10-05', 17)} as same from public.bookings where id = $1`,
        [rows[0].id],
      );
      expect(chk[0].same).toBe(true);
    });
  });

  test('one-off conflict returns PT409 booking_conflict with zero new rows', async () => {
    await ensureProfiles();
    // Pre-existing booking in the same room/instant (committed independently).
    let existingId: string | null = null;
    await asAuthenticated(CLAIMS_A, async (client) => {
      const r = await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ${sofia('2026-10-06', 17)}) returning id`,
        [CLASS_A],
      );
      existingId = r.rows[0].id;
    });
    // A colliding one-off creation must fail and create no rows.
    await asAuthenticated(CLAIMS_A, async (client) => {
      try {
        await client.query(
          `select * from public.schedule_bookings($1::uuid, $2::public.room, $3::date, $4::int, 1, null)`,
          [CLASS_A, 'room_1', '2026-10-06', 17],
        );
        throw new Error('expected booking_conflict');
      } catch (e: any) {
        expect(e.code).toBe('PT409');
        expect(e.message).toMatch(/booking_conflict/);
      }
    });
    // Exactly one row exists for that slot: the pre-existing one, none from the RPC.
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select count(*)::int as n from public.bookings
         where class_id = $1 and room = 'room_1' and starts_at = ${sofia('2026-10-06', 17)}`,
        [CLASS_A],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      verify.release();
    }
    // Cleanup the pre-existing row explicitly.
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.bookings where id = $1', [existingId]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

});
