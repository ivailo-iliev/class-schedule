import { describe, test, expect, afterAll } from 'vitest';
import { db, asAuthenticated } from './helpers';

// Dedicated profiles for this suite so state does not collide with
// bookings.test.ts (7777...) or the shared seed fixtures (1111/2222/3333).
const R_A = '88888888-8888-8888-8888-888888888801'; // teacher, owner of class
const R_B = '88888888-8888-8888-8888-888888888802'; // other teacher
const R_ADM = '88888888-8888-8888-8888-888888888803'; // admin

const CLAIMS_A = {
  sub: R_A, role: 'authenticated',
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

// Run a throwing query inside asAuthenticated, then verify the resulting state
// on a FRESH connection (the original client's transaction is aborted once the
// RPC raises, so follow-up queries on it would fail with "current transaction
// is aborted").
async function expectRejectThenCount(
  claims: Record<string, unknown>,
  sql: string,
  params: unknown[],
  expectCode: string,
  expectMsg: RegExp,
  classId: string,
  expectRows: number,
) {
  await asAuthenticated(claims, async (client) => {
    try {
      await client.query(sql, params);
      throw new Error('expected rejection');
    } catch (e: any) {
      if (/expected rejection/.test(e.message)) throw e;
      expect(e.code).toBe(expectCode);
      expect(e.message).toMatch(expectMsg);
    }
  });
  const verify = await db();
  try {
    const { rows } = await verify.query(
      `select count(*)::int as n from public.bookings where class_id = $1`,
      [classId],
    );
    expect(rows[0].n).toBe(expectRows);
  } finally {
    verify.release();
  }
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

async function clearClassBookings() {
  const c = await db();
  try {
    await c.query('alter table public.bookings disable trigger bookings_guard');
    await c.query('delete from public.bookings where class_id = $1', [CLASS_A]);
    await c.query('alter table public.bookings enable trigger bookings_guard');
  } finally {
    c.release();
  }
}

describe('weekly recurrence (exact N local-time occurrences)', () => {

  // Tuesday 2026-09-15 17:00, N=12 -> the 12 listed dates, no series row.
  const EXPECTED_WEEKLY = [
    '2026-09-15', '2026-09-22', '2026-09-29',
    '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27',
    '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24',
    '2026-12-01',
  ];

  test('weekly creates exactly N distinct local-time occurrences', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows } = await client.query(
        `select * from public.schedule_bookings(
           $1::uuid, $2::public.room, $3::date, $4::int, $5::int, $6::int)`,
        [CLASS_A, 'room_1', '2026-09-15', 17, 12, 2], // Tuesday = 2
      );
      expect(rows.length).toBe(12);
      // Every generated booking is owned by the class and in room_1.
      for (const r of rows) {
        expect(r.class_id).toBe(CLASS_A);
        expect(r.room).toBe('room_1');
        expect(Number(r.version)).toBe(1);
      }
      const { rows: local } = await client.query(
        `select to_char(starts_at at time zone 'Europe/Sofia', 'YYYY-MM-DD') as d
           from public.bookings where class_id = $1 order by starts_at`,
        [CLASS_A],
      );
      expect(local.map(r => r.d)).toEqual(EXPECTED_WEEKLY);
      // All at wall-clock hour 17:00, no UTC-week drift across weeks.
      const { rows: hrs } = await client.query(
        `select distinct extract(hour from starts_at at time zone 'Europe/Sofia') as h
           from public.bookings where class_id = $1`,
        [CLASS_A],
      );
      expect(hrs.map(r => Number(r.h))).toEqual([17]);
      // No series/parent row exists: occurrences are independent bookings.
      const { rows: cnt } = await client.query(
        `select count(*)::int as n from public.bookings where class_id = $1`,
        [CLASS_A],
      );
      expect(cnt[0].n).toBe(12);
    });
  });

  test('weekly stride is exactly 7 local days, never a fixed UTC offset', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows } = await client.query(
        `select starts_at from public.schedule_bookings(
           $1::uuid, $2::public.room, $3::date, $4::int, $5::int, $6::int) order by starts_at`,
        [CLASS_A, 'room_2', '2026-03-17', 10, 4, 2], // spans spring DST
      );
      // Local dates must be 03-17, 03-24, 03-31, 04-07 (each +7 days).
      const localDates = rows.map(r =>
        (r.starts_at instanceof Date
          ? r.starts_at.toISOString()
          : String(r.starts_at)).slice(0, 10));
      // Re-derive local date in SQL to avoid TZ issues in the test runner.
      const { rows: ld } = await client.query(
        `select to_char(b.starts_at at time zone 'Europe/Sofia', 'YYYY-MM-DD') as d
           from public.bookings b where class_id = $1 order by b.starts_at`,
        [CLASS_A],
      );
      expect(ld.map(r => r.d)).toEqual(
        ['2026-03-17', '2026-03-24', '2026-03-31', '2026-04-07'],
      );
    });
  });

});

describe('recurrence bounds and weekday validation', () => {

  test('N=0 is rejected with zero batch rows', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await expectRejectThenCount(
      CLAIMS_A,
      `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,$5::int,$6::int)`,
      [CLASS_A, 'room_1', '2026-09-15', 17, 0, 2],
      'PT422', /invalid_recurrence/, CLASS_A, 0,
    );
  });

  test('N=105 (above cap) is rejected with zero batch rows', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await expectRejectThenCount(
      CLAIMS_A,
      `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,$5::int,$6::int)`,
      [CLASS_A, 'room_1', '2026-09-15', 17, 105, 2],
      'PT422', /invalid_recurrence/, CLASS_A, 0,
    );
  });

  test('null occurrences is rejected', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      try {
        await client.query(
          `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,null,$5::int)`,
          [CLASS_A, 'room_1', '2026-09-15', 17, 2],
        );
        throw new Error('expected invalid_recurrence');
      } catch (e: any) {
        expect(e.code).toBe('PT422');
        expect(e.message).toMatch(/invalid_recurrence/);
      }
    });
  });

  test('fractional API occurrences is rejected (no partial series)', async () => {
    await ensureProfiles();
    await clearClassBookings();
    // A non-integer positional argument cannot satisfy the integer parameter,
    // so Postgres rejects the call before any row is written.
    await asAuthenticated(CLAIMS_A, async (client) => {
      try {
        await client.query(
          `select * from public.schedule_bookings($1, $2, $3, $4, $5, $6)`,
          [CLASS_A, 'room_1', '2026-09-15', 17, 12.5, 2],
        );
        throw new Error('expected rejection of fractional occurrences');
      } catch (e: any) {
        // Postgres rejects the non-integer coercion (22P02) or the call shape
        // (42883) before any row is written.
        expect(['22P02', '42883']).toContain(e.code);
      }
    });
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select count(*)::int as n from public.bookings where class_id = $1`,
        [CLASS_A],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      verify.release();
    }
  });

  test('weekday mismatch is rejected with zero batch rows', async () => {
    await ensureProfiles();
    await clearClassBookings();
    // 2026-09-15 is Tuesday(2); passing weekday=3 (Wednesday) must fail.
    await expectRejectThenCount(
      CLAIMS_A,
      `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,$5::int,$6::int)`,
      [CLASS_A, 'room_1', '2026-09-15', 17, 4, 3],
      'PT422', /invalid_recurrence/, CLASS_A, 0,
    );
  });

  test('weekday required when occurrences > 1', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      try {
        await client.query(
          `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,$5::int,null)`,
          [CLASS_A, 'room_1', '2026-09-15', 17, 4],
        );
        throw new Error('expected invalid_recurrence');
      } catch (e: any) {
        expect(e.code).toBe('PT422');
        expect(e.message).toMatch(/invalid_recurrence/);
      }
    });
  });

});

describe('all-or-nothing weekly conflicts', () => {

  // Pre-create a committed booking at the given local slot, then run a full
  // weekly creation on a FRESH connection and assert it returns PT409 with
  // zero new batch rows (only the single pre-existing row remains).
  async function conflictAt(label: string, date: string) {
    // Pre-existing committed booking in the colliding slot on its own connection.
    await asAuthenticated(CLAIMS_A, async (client) => {
      await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ${sofia(date, 17)})`,
        [CLASS_A],
      );
    });
    await expectRejectThenCount(
      CLAIMS_A,
      `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,$5::int,$6::int)`,
      [CLASS_A, 'room_1', '2026-09-15', 17, 12, 2],
      'PT409',
      /booking_conflict/,
      CLASS_A,
      1, // the single pre-existing row; zero batch rows were written
    );
  }

  test('conflict at the FIRST occurrence creates zero batch rows', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await conflictAt('first', '2026-09-15');
  });

  test('conflict at a MIDDLE occurrence creates zero batch rows', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await conflictAt('middle', '2026-10-20');
  });

  test('conflict at the LAST occurrence creates zero batch rows', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await conflictAt('last', '2026-12-01');
  });

});

describe('Europe/Sofia daylight-saving rules', () => {

  test('spring-forward: 10:00 wall preserved, UTC shifts from 08:00Z to 07:00Z', async () => {
    await ensureProfiles();
    // Before DST (2026-03-22): 10:00 Sofia = 08:00Z.
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows: a } = await client.query(
        `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,1,null)`,
        [CLASS_A, 'room_1', '2026-03-22', 10],
      );
      const { rows: aUtc } = await client.query(
        `select starts_at as u,
                extract(hour from starts_at at time zone 'Europe/Sofia') as h
           from public.bookings where id = $1`,
        [a[0].id],
      );
      expect(aUtc[0].u.toISOString()).toBe('2026-03-22T08:00:00.000Z');
      expect(Number(aUtc[0].h)).toBe(10);
    });
    // Clear the first booking on its own committed connection BEFORE starting
    // the second block, so no in-flight row lock blocks the DDL below.
    await clearClassBookings();
    // After DST (2026-03-29): 10:00 Sofia = 07:00Z, still wall 10:00.
    await asAuthenticated(CLAIMS_A, async (client) => {
      const { rows: b } = await client.query(
        `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,1,null)`,
        [CLASS_A, 'room_1', '2026-03-29', 10],
      );
      const { rows: bUtc } = await client.query(
        `select starts_at as u,
                extract(hour from starts_at at time zone 'Europe/Sofia') as h
           from public.bookings where id = $1`,
        [b[0].id],
      );
      expect(bUtc[0].u.toISOString()).toBe('2026-03-29T07:00:00.000Z');
      expect(Number(bUtc[0].h)).toBe(10);
    });
    await clearClassBookings();
  });

  test('nonexistent spring-forward hour 03:00 on 2026-03-29 is rejected', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      try {
        await client.query(
          `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,1,null)`,
          [CLASS_A, 'room_1', '2026-03-29', 3],
        );
        throw new Error('expected invalid_slot');
      } catch (e: any) {
        expect(e.code).toBe('PT422');
        expect(e.message).toMatch(/invalid_slot/);
      }
    });
  });

  test('ambiguous fall-back hour 03:00 on 2026-10-25 is rejected', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      try {
        await client.query(
          `select * from public.schedule_bookings($1::uuid,$2::public.room,$3::date,$4::int,1,null)`,
          [CLASS_A, 'room_1', '2026-10-25', 3],
        );
        throw new Error('expected invalid_slot');
      } catch (e: any) {
        expect(e.code).toBe('PT422');
        expect(e.message).toMatch(/invalid_slot/);
      }
    });
  });

  test('ambiguous fall-back hour 03:00 is rejected by the slot resolver (not just the CHECK)', async () => {
    await ensureProfiles();
    await clearClassBookings();
    await asAuthenticated(CLAIMS_A, async (client) => {
      // Ambiguity is only meaningful at the date+hour entry point: the same
      // wall-clock 03:00 maps to two UTC instants. resolve_slot inspects the
      // surrounding offsets and rejects it before any row is written.
      try {
        await client.query(
          `select private.resolve_slot($1::date, $2::int)`,
          ['2026-10-25', 3],
        );
        throw new Error('expected invalid_slot');
      } catch (e: any) {
        expect(e.code).toBe('PT422');
        expect(e.message).toMatch(/invalid_slot/);
      }
    });
  });

});
