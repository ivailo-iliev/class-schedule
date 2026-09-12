import { describe, test, expect, afterAll } from 'vitest';
import { db, asAuthenticated } from './helpers';

// Dedicated profiles for this suite so class/booking state does not collide
// with classes.test.ts (which owns T_C/T_D/ADM) or the shared seed fixtures.
const T_E = '77777777-7777-7777-7777-777777777701'; // teacher owned by this suite
const T_F = '77777777-7777-7777-7777-777777777702'; // other teacher
const ADM = '77777777-7777-7777-7777-777777777703'; // admin in this suite

const CLAIMS_E = {
  sub: T_E, role: 'authenticated',
  app: 'class-scheduler-v1', credential_version: 1,
};
const CLAIMS_F = {
  sub: T_F, role: 'authenticated',
  app: 'class-scheduler-v1', credential_version: 1,
};
const CLAIMS_ADM = {
  sub: ADM, role: 'authenticated',
  app: 'class-scheduler-v1', credential_version: 1,
};

// Stable class ids owned by this suite's profiles.
const CLASS_E = '77777777-7777-7777-7777-aaaaaaaaaa01';
const CLASS_F = '77777777-7777-7777-7777-bbbbbbbbbb02';

let setupDone = false;
async function ensureProfiles() {
  if (setupDone) return;
  const c = await db();
  try {
    await c.query(
      `insert into public.profiles (id, name, role, active, access_token_hash) values
        ($1, 'Booking Teacher', 'teacher', true,
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        ($2, 'Booking Other', 'teacher', true,
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        ($3, 'Booking Admin', 'admin', true,
          '0101010101010101010101010101010101010101010101010101010101010101')
      on conflict (id) do nothing`,
      [T_E, T_F, ADM],
    );
    await c.query(
      `insert into public.classes (id, teacher_id, name, active) values
        ($1, $2, 'Class E', true),
        ($3, $4, 'Class F', true)
      on conflict (id) do nothing`,
      [CLASS_E, T_E, CLASS_F, T_F],
    );
    setupDone = true;
  } finally {
    c.release();
  }
}

afterAll(async () => {
  const c = await db();
  try {
    await c.query(`alter table public.profiles disable trigger profiles_guard`);
    await c.query('alter table public.bookings disable trigger bookings_guard');
    await c.query('alter table public.classes disable trigger classes_guard');
    // Delete by teacher_id so transient classes (e.g. the inactive one created
    // inside a test) are also removed, not just CLASS_E/CLASS_F.
    await c.query(
      `delete from public.bookings where class_id in (
         select id from public.classes where teacher_id = any($1))`,
      [[T_E, T_F, ADM]],
    );
    await c.query(`delete from public.classes where teacher_id = any($1)`, [[T_E, T_F, ADM]]);
    await c.query('delete from public.profiles where id = any($1)', [[T_E, T_F, ADM]]);
    await c.query('alter table public.classes enable trigger classes_guard');
    await c.query('alter table public.bookings enable trigger bookings_guard');
    await c.query('alter table public.profiles enable trigger profiles_guard');
  } finally {
    c.release();
  }
});

// Convert a date + hour into the Sofia-stored timestamptz literal used by tests.
function sofia(date: string, hour: number): string {
  return `((date '${date}' + make_time(${hour},0,0)) at time zone 'Europe/Sofia')`;
}

describe('booking slot guards', () => {

  test('invalid room enum value is rejected', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_3', ${sofia('2026-11-03', 9)})`,
          [CLASS_E],
        ),
      ).rejects.toThrow();
    });
  });

  test('null starts_at is rejected', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1', null)`,
          [CLASS_E],
        ),
      ).rejects.toThrow();
    });
  });

  test(':30 minute start is rejected', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1',
             (date '2026-11-03' + make_time(9,30,0)) at time zone 'Europe/Sofia')`,
          [CLASS_E],
        ),
      ).rejects.toThrow();
    });
  });

  test('seconds in start is rejected', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1',
             (date '2026-11-03' + make_time(9,0,15)) at time zone 'Europe/Sofia')`,
          [CLASS_E],
        ),
      ).rejects.toThrow();
    });
  });

  test('fractional seconds in start is rejected', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1',
             (date '2026-11-03' + make_time(9,0,0) + interval '0.5 second')
             at time zone 'Europe/Sofia')`,
          [CLASS_E],
        ),
      ).rejects.toThrow();
    });
  });

  test('infinity start is rejected (bookings_finite_start)', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1', 'infinity'::timestamptz)`,
          [CLASS_E],
        ),
      ).rejects.toThrow();
    });
  });

  test('duplicate room+instant is rejected with 23505', async () => {
    await ensureProfiles();
    let bookingId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ('bebebebe-0001-0001-0001-000000000001', $1, 'room_1', ${sofia('2026-11-04', 9)})
         returning id`,
        [CLASS_E],
      );
      bookingId = ins.rows[0].id;
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_E, async (client) => {
      try {
        await client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1', ${sofia('2026-11-04', 9)})`,
          [CLASS_E],
        );
        throw new Error('expected unique violation');
      } catch (e: any) {
        expect(e.code).toBe('23505');
      }
    });
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.bookings where id = $1', [bookingId]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

  test('same instant in a different room succeeds', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      const { rows } = await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_2', ${sofia('2026-11-05', 9)}) returning id, room`,
        [CLASS_E],
      );
      expect(rows[0].room).toBe('room_2');
    });
  });

  test('adjacent hours (same room) both succeed', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      const r1 = await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ${sofia('2026-11-06', 9)}) returning id`,
        [CLASS_E],
      );
      const r2 = await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ${sofia('2026-11-06', 10)}) returning id`,
        [CLASS_E],
      );
      expect(r1.rowCount).toBe(1);
      expect(r2.rowCount).toBe(1);
    });
  });

  test('explicit-offset strings representing the same instant conflict', async () => {
    // 2026-11-07 09:00 Europe/Sofia == 07:00:00Z; both forms must collide.
    await ensureProfiles();
    let bookingId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ('bebebebe-0002-0002-0002-000000000002', $1, 'room_1',
           '2026-11-07T07:00:00+00:00'::timestamptz) returning id`,
        [CLASS_E],
      );
      bookingId = ins.rows[0].id;
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_E, async (client) => {
      try {
        await client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1', '2026-11-07T09:00:00+02:00'::timestamptz)`,
          [CLASS_E],
        );
        throw new Error('expected unique violation');
      } catch (e: any) {
        expect(e.code).toBe('23505');
      }
    });
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.bookings where id = $1', [bookingId]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

  test('cancelled booking frees its slot for reuse', async () => {
    await ensureProfiles();
    let bookingId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ('bebebebe-0003-0003-0003-000000000003', $1, 'room_1',
           ${sofia('2026-11-08', 9)}) returning id`,
        [CLASS_E],
      );
      bookingId = ins.rows[0].id;
    } finally {
      c.release();
    }
    // Cancel the booking via direct authorized update.
    await asAuthenticated(CLAIMS_E, async (client) => {
      await client.query(
        `update public.bookings set cancelled_at = statement_timestamp()
         where id = $1`,
        [bookingId],
      );
    });
    // A new booking in the same room/instant must now succeed (active_slot NULL).
    await asAuthenticated(CLAIMS_E, async (client) => {
      const r = await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ${sofia('2026-11-08', 9)}) returning id`,
        [CLASS_E],
      );
      expect(r.rowCount).toBe(1);
    });
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query(
        `delete from public.bookings where (id = $1 or class_id = $2 and starts_at = ${sofia('2026-11-08', 9)})`,
        [bookingId, CLASS_E],
      );
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

});

describe('booking ownership and audit guards', () => {

  test('cannot insert a booking into another teacher class (USING path)', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_E, async (client) => {
      // RLS hides the other teacher's class, so the booking_guard's FOR SHARE
      // lookup raises class_not_found; no row may be created.
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1', ${sofia('2026-11-09', 9)})`,
          [CLASS_F],
        ),
      ).rejects.toThrow(/class_not_found|permission denied/);
    });
    // Ensure no row leaked in.
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select id from public.bookings where class_id = $1`,
        [CLASS_F],
      );
      expect(rows.length).toBe(0);
    } finally {
      verify.release();
    }
  });

  test('cannot change a booking class to another teacher class (WITH CHECK)', async () => {
    await ensureProfiles();
    let bookingId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ('bebebebe-0004-0004-0004-000000000004', $1, 'room_1',
           ${sofia('2026-11-10', 9)}) returning id`,
        [CLASS_E],
      );
      bookingId = ins.rows[0].id;
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_E, async (client) => {
      // The target class is invisible under RLS, so the trigger lookup fails.
      await expect(
        client.query(
          `update public.bookings set class_id = $1 where id = $2`,
          [CLASS_F, bookingId],
        ),
      ).rejects.toThrow(/class_not_found|permission denied/);
    });
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select class_id from public.bookings where id = $1`,
        [bookingId],
      );
      expect(rows[0].class_id).toBe(CLASS_E);
    } finally {
      verify.release();
    }
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.bookings where id = $1', [bookingId]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

  test('forged audit fields are overwritten (created_by/version/updated_by)', async () => {
    await ensureProfiles();
    let bookingId: string | null = null;
    // Insert as the authenticated owner using ONLY grantable columns (id is not
    // granted for INSERT, so we let it default). The SECURITY INVOKER trigger
    // must stamp created_by/updated_by from the live actor and reset version 1.
    await asAuthenticated(CLAIMS_E, async (client) => {
      const ins = await client.query(
        `insert into public.bookings (class_id, room, starts_at)
         values ($1, 'room_1', ${sofia('2026-11-11', 9)}) returning id`,
        [CLASS_E],
      );
      bookingId = ins.rows[0].id;
    });
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select created_by, version, updated_by
         from public.bookings where id = $1`,
        [bookingId],
      );
      // created_by/updated_by must be the authenticated actor, version reset to 1.
      expect(rows[0].created_by).toBe(T_E);
      expect(rows[0].updated_by).toBe(T_E);
      expect(Number(rows[0].version)).toBe(1);
    } finally {
      verify.release();
    }
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.bookings where id = $1', [bookingId]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

  test('once cancelled, a booking cannot be edited (terminal)', async () => {
    await ensureProfiles();
    let bookingId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ('bebebebe-0006-0006-0006-000000000006', $1, 'room_1',
           ${sofia('2026-11-12', 9)}) returning id`,
        [CLASS_E],
      );
      bookingId = ins.rows[0].id;
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_E, async (client) => {
      await client.query(
        `update public.bookings set cancelled_at = statement_timestamp() where id = $1`,
        [bookingId],
      );
      // Attempt to edit the cancelled booking.
      await expect(
        client.query(
          `update public.bookings set room = 'room_2' where id = $1`,
          [bookingId],
        ),
      ).rejects.toThrow();
    });
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.bookings where id = $1', [bookingId]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

  test('inactive class blocks booking creation', async () => {
    await ensureProfiles();
    const c = await db();
    let inactiveClass: string | null = null;
    try {
      const ins = await c.query(
        `insert into public.classes (id, teacher_id, name, active)
         values ('77777777-7777-7777-7777-cccccccccc04', $1, 'Inactive', false)
         on conflict (id) do nothing
         returning id`,
        [T_E],
      );
      inactiveClass = ins.rows[0]?.id ?? '77777777-7777-7777-7777-cccccccccc04';
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_E, async (client) => {
      // The booking_guard must reject an inactive-class booking outright.
      await expect(
        client.query(
          `insert into public.bookings (class_id, room, starts_at)
           values ($1, 'room_1', ${sofia('2026-11-13', 9)})`,
          [inactiveClass],
        ),
      ).rejects.toThrow(/active_class_required/);
    });
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select id from public.bookings where class_id = $1`,
        [inactiveClass],
      );
      expect(rows.length).toBe(0);
    } finally {
      verify.release();
    }
    const cleanup = await db();
    try {
      await cleanup.query('alter table public.bookings disable trigger bookings_guard');
      await cleanup.query('delete from public.classes where id = $1', [inactiveClass]);
      await cleanup.query('alter table public.bookings enable trigger bookings_guard');
    } finally {
      cleanup.release();
    }
  });

});
