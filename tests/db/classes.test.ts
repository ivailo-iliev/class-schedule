import { describe, test, expect, afterAll } from 'vitest';
import { db, asAuthenticated } from './helpers';

// Dedicated profiles for this suite so parallel runs of identity.test.ts
// (which deactivates the shared seed profile T_A) cannot interfere.
const T_C = '44444444-4444-4444-4444-444444444444'; // teacher owned by this suite
const T_D = '55555555-5555-5555-5555-555555555555'; // other teacher
const ADM = '66666666-6666-6666-6666-666666666666'; // admin in this suite

const CLAIMS_C = {
  sub: T_C, role: 'authenticated',
};
const CLAIMS_D = {
  sub: T_D, role: 'authenticated',
};
const CLAIMS_ADM = {
  sub: ADM, role: 'authenticated',
};

// Seeded fixtures (read-only use by this suite).
const A_CLASS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const A_BOOKING = 'cabababa-0001-0001-0001-000000000001';

let setupDone = false;
async function ensureProfiles() {
  if (setupDone) return;
  const c = await db();
  try {
    await c.query(
      `insert into public.profiles (id, name, role, active, access_token_hash) values
        ($1, 'Suite Teacher', 'teacher', true,
          'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
        ($2, 'Suite Other', 'teacher', true,
          'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        ($3, 'Suite Admin', 'admin', true,
          'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
      on conflict (id) do nothing`,
      [T_C, T_D, ADM],
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
    // Remove dependent rows first to avoid FK violations, then the profiles.
    // Bookings reference classes (and classes/profiles via created_by), so
    // delete bookings tied to this suite's classes before the classes.
    await c.query(
      `delete from public.bookings where class_id in (
         select id from public.classes where teacher_id = any($1))`,
      [[T_C, T_D, ADM]],
    );
    await c.query(
      `delete from public.classes where teacher_id = any($1)`, [[T_C, T_D, ADM]],
    );
    await c.query('delete from public.profiles where id = any($1)', [[T_C, T_D, ADM]]);
    await c.query('alter table public.profiles enable trigger profiles_guard');
  } finally {
    c.release();
  }
});

describe('class ownership', () => {

  test('teacher inserts class without owner input and database supplies the actor', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_C, async (client) => {
      const { rows } = await client.query(
        `insert into public.classes (name) values ('C New Class') returning id, teacher_id, name`,
      );
      expect(rows[0].teacher_id).toBe(T_C);
      expect(rows[0].name).toBe('C New Class');
    });
  });

  test('teacher cannot force a class owned by another teacher', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_C, async (client) => {
      await expect(
        client.query(
          `insert into public.classes (teacher_id, name) values ($1, 'Forbidden')`,
          [T_D],
        ),
      ).rejects.toThrow();
    });
  });

  test('admin can create a class owned by another teacher', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_ADM, async (client) => {
      const { rows } = await client.query(
        `insert into public.classes (teacher_id, name) values ($1, 'Admin D Class') returning id, teacher_id`,
        [T_D],
      );
      expect(rows[0].teacher_id).toBe(T_D);
    });
  });

  test('admin cannot create a class owned by a non-teacher (admin self)', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_ADM, async (client) => {
      await expect(
        client.query(
          `insert into public.classes (teacher_id, name) values ($1, 'Self Owned')`,
          [ADM],
        ),
      ).rejects.toThrow();
    });
  });

  test('class owner is immutable: owner swap is rejected', async () => {
    await ensureProfiles();
    let createdId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.classes (teacher_id, name) values ($1, 'Swap Target') returning id`,
        [T_C],
      );
      createdId = ins.rows[0].id;
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_C, async (client) => {
      await expect(
        client.query(
          `update public.classes set teacher_id = $1 where id = $2`,
          [T_D, createdId],
        ),
      ).rejects.toThrow();
    });
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select teacher_id from public.classes where id = $1`,
        [createdId],
      );
      expect(rows[0].teacher_id).toBe(T_C);
    } finally {
      verify.release();
    }
  });

  test('class owner swap rejected via direct SQL as authenticated owner', async () => {
    await ensureProfiles();
    const c = await db();
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify(CLAIMS_C)],
      );
      await c.query('SET LOCAL ROLE authenticated');
      const ins = await c.query(
        `insert into public.classes (name) values ('Direct SQL Class') returning id`,
      );
      const id = ins.rows[0].id;
      await expect(
        c.query(
          `update public.classes set teacher_id = $1 where id = $2`,
          [T_D, id],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  test('cross-teacher update is denied and persisted state unchanged', async () => {
    await ensureProfiles();
    await asAuthenticated(CLAIMS_D, async (client) => {
      const r = await client.query(
        `update public.classes set name = 'Hacked By D' where id = $1`,
        [A_CLASS],
      );
      expect(r.rowCount ?? 0).toBe(0);
    });
    const c = await db();
    try {
      const { rows } = await c.query(
        `select name from public.classes where id = $1`,
        [A_CLASS],
      );
      expect(rows[0].name).toBe('Morning Yoga');
    } finally {
      c.release();
    }
  });

  test('deactivating a class does not cancel its bookings', async () => {
    await ensureProfiles();
    let classId: string | null = null;
    let bookingId: string | null = null;
    const c = await db();
    try {
      const ins = await c.query(
        `insert into public.classes (teacher_id, name) values ($1, 'To Deactivate') returning id`,
        [T_C],
      );
      classId = ins.rows[0].id;
      const b = await c.query(
        `insert into public.bookings (id, class_id, room, starts_at)
         values ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', $1, 'room_1',
           (date '2026-11-02' + make_time(9,0,0)) at time zone 'Europe/Sofia')
         returning id`,
        [classId],
      );
      bookingId = b.rows[0].id;
    } finally {
      c.release();
    }
    await asAuthenticated(CLAIMS_C, async (client) => {
      await client.query(
        `update public.classes set active = false where id = $1`,
        [classId],
      );
    });
    const verify = await db();
    try {
      const { rows } = await verify.query(
        `select cancelled_at from public.bookings where id = $1`,
        [bookingId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].cancelled_at).toBeNull();
      // Restore
      await verify.query(`update public.classes set active = true where id = $1`, [classId]);
    } finally {
      verify.release();
    }
  });

  test('active teacher is required as class owner', async () => {
    await ensureProfiles();
    const T_TEMP = '77777777-7777-7777-7777-777777777777';
    const c = await db();
    try {
      await c.query(
        `insert into public.profiles (id, name, role, active, access_token_hash)
         values ($1, 'Temp Teacher', 'teacher', true,
           '7777777777777777777777777777777777777777777777777777777777777777')`,
        [T_TEMP],
      );
      await c.query(`update public.profiles set active = false where id = $1`, [T_TEMP]);
      await asAuthenticated(
        { sub: T_TEMP, role: 'authenticated',
        },
        async (client) => {
          await expect(
            client.query(`insert into public.classes (name) values ('While Inactive')`),
          ).rejects.toThrow();
        },
      );
    } finally {
      await c.query('alter table public.profiles disable trigger profiles_guard');
      await c.query(`delete from public.profiles where id = $1`, [T_TEMP]);
      await c.query('alter table public.profiles enable trigger profiles_guard');
      c.release();
    }
  });

});
