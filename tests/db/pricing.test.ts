import { afterAll, describe, expect, test } from 'vitest';
import pg from 'pg';
import { asAuthenticated, db } from './helpers';

const ELEONORA = '11111111-1111-1111-1111-111111111111';
const GALYA = '44444444-4444-4444-4444-444444444444';
const CLASS_E = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLASS_G = '77777777-7777-7777-7777-777777777701';
const CLAIMS_E = { sub: ELEONORA, role: 'authenticated' };
const CLAIMS_G = { sub: GALYA, role: 'authenticated' };

async function ensureGalyaClass() {
  const client = await db();
  try {
    await client.query(
      `insert into public.classes(id, teacher_id, name, active)
       values ($1, $2, 'Pricing test class', true)
       on conflict (id) do update set active = true`,
      [CLASS_G, GALYA],
    );
  } finally {
    client.release();
  }
}

async function expectRejected(client: pg.PoolClient, action: () => Promise<unknown>, message: RegExp) {
  await client.query('savepoint expected_failure');
  await expect(action()).rejects.toThrow(message);
  await client.query('rollback to savepoint expected_failure');
}

async function quote(
  client: pg.PoolClient, classId: string, occurrences: unknown[], room = 'hall',
) {
  const { rows } = await client.query(
    'select public.quote_booking($1, $2::public.room, $3::jsonb) as quote',
    [classId, room, JSON.stringify(occurrences)],
  );
  return rows[0].quote;
}

async function create(
  client: pg.PoolClient, classId: string, occurrences: unknown[], room = 'hall',
) {
  const { rows } = await client.query(
    'select public.create_booking_series($1, $2::public.room, $3, $4::jsonb) as created',
    [classId, room, 'Student', JSON.stringify(occurrences)],
  );
  return rows[0].created;
}

afterAll(async () => {
  const client = await db();
  try {
    await client.query('alter table public.bookings disable trigger bookings_guard');
    await client.query('delete from public.bookings where class_id = $1', [CLASS_G]);
    await client.query('delete from public.classes where id = $1', [CLASS_G]);
    await client.query(`delete from private.pricing_rules where label like 'pricing-test-%'`);
    await client.query('alter table public.bookings enable trigger bookings_guard');
  } finally {
    client.release();
  }
});

describe('authoritative booking pricing RPCs', () => {
  test('quotes each half-hour, including the exact €42.50 standard boundary total', async () => {
    await ensureGalyaClass();
    await asAuthenticated(CLAIMS_G, async (client) => {
      const result = await quote(client, CLASS_G, [
        { starts_at: '2026-10-05T16:30:00', ends_at: '2026-10-05T18:30:00' },
      ]);
      expect(result.total_amount).toBe('42.50');
      expect(result.occurrences[0].amount).toBe('42.50');
      expect(result.occurrences[0].segments).toHaveLength(4);
      expect(result.occurrences[0].segments.map((s: any) => s.subtotal))
        .toEqual(['5.00', '12.50', '12.50', '12.50']);
    });
  });

  test('uses a zero-price teacher time rule before whole-day and standard rules', async () => {
    await asAuthenticated(CLAIMS_E, async (client) => {
      const result = await quote(client, CLASS_E, [
        { starts_at: '2026-10-05T13:30:00', ends_at: '2026-10-05T14:30:00' },
      ]);
      expect(result.total_amount).toBe('0.00');
      expect(result.occurrences[0].segments.every((s: any) => s.hourly_rate === '0.00')).toBe(true);
    });
  });

  test('rejects missing and tied winning pricing rules', async () => {
    await ensureGalyaClass();
    await asAuthenticated(CLAIMS_G, async (client) => {
      await expectRejected(client, () => quote(client, CLASS_G, [
        { starts_at: '2026-10-05T20:00:00', ends_at: '2026-10-05T20:30:00' },
      ]), /pricing_configuration_error/);
    });
    const owner = await db();
    try {
      await owner.query(
        `insert into private.pricing_rules
          (teacher_id, weekdays, start_time, end_time, hourly_rate, priority, label)
         values ($1, array[1]::smallint[], '10:00', '10:30', 9, 99, 'pricing-test-a'),
                ($1, array[1]::smallint[], '10:00', '10:30', 8, 99, 'pricing-test-b')`,
        [GALYA],
      );
    } finally {
      owner.release();
    }
    await asAuthenticated(CLAIMS_G, async (client) => {
      await expectRejected(client, () => quote(client, CLASS_G, [
        { starts_at: '2026-10-05T10:00:00', ends_at: '2026-10-05T10:30:00' },
      ]), /pricing_configuration_error/);
    });
  });

  test('creates all rows atomically and does not trust an earlier quote', async () => {
    await ensureGalyaClass();
    const conflict = '2026-10-06T09:00:00';
    await asAuthenticated(CLAIMS_G, async (client) => {
      await create(client, CLASS_G, [
        { starts_at: conflict, ends_at: '2026-10-06T09:30:00' },
      ]);
    });
    await asAuthenticated(CLAIMS_G, async (client) => {
      await expect(create(client, CLASS_G, [
        { starts_at: '2026-10-06T10:00:00', ends_at: '2026-10-06T10:30:00' },
        { starts_at: conflict, ends_at: '2026-10-06T09:30:00' },
      ])).rejects.toThrow(/booking_conflict/);
    });
    const owner = await db();
    try {
      const { rows } = await owner.query(
        `select starts_at::text from public.bookings where class_id = $1 and cancelled_at is null`,
        [CLASS_G],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].starts_at).toContain('09:00:00');
    } finally {
      owner.release();
    }
  });

  test('edits one occurrence with a versioned authoritative snapshot and cancels future by immutable index', async () => {
    await ensureGalyaClass();
    let created: any;
    await asAuthenticated(CLAIMS_G, async (client) => {
      created = await create(client, CLASS_G, [
        { starts_at: '2026-10-07T09:00:00', ends_at: '2026-10-07T10:00:00' },
        { starts_at: '2026-10-14T09:00:00', ends_at: '2026-10-14T10:00:00' },
        { starts_at: '2026-10-21T09:00:00', ends_at: '2026-10-21T10:00:00' },
      ], 'room');
      const id = created.bookings[1].id;
      const { rows } = await client.query(
        `select public.edit_booking($1, 1, $2, 'room'::public.room,
          '2026-10-08T17:00:00'::timestamp, '2026-10-08T18:00:00'::timestamp, 'Changed') as edited`,
        [id, CLASS_G],
      );
      expect(rows[0].edited.amount).toBe('25.00');
      await expectRejected(client, () => client.query(
        `select public.edit_booking($1, 1, $2, 'room'::public.room,
          '2026-10-08T17:00:00'::timestamp, '2026-10-08T18:00:00'::timestamp, 'Changed')`,
        [id, CLASS_G],
      ), /stale_booking/);
      const { rows: cancelled } = await client.query(
        `select public.cancel_booking($1, 2, 'future') as cancelled`, [id],
      );
      expect(cancelled[0].cancelled.cancelled_count).toBe(2);
      const { rows: repeated } = await client.query(
        `select public.cancel_booking($1, 999, 'future') as cancelled`, [id],
      );
      expect(repeated[0].cancelled.cancelled_count).toBe(0);
    });
    const owner = await db();
    try {
      const { rows } = await owner.query(
        `select series_index, cancelled_at is not null as cancelled
         from public.bookings where series_id = $1 order by series_index`,
        [created.series_id],
      );
      expect(rows).toEqual([
        { series_index: 0, cancelled: false },
        { series_index: 1, cancelled: true },
        { series_index: 2, cancelled: true },
      ]);
    } finally {
      owner.release();
    }
  });

  test('validates bounded unique local occurrences and active owned classes before pricing', async () => {
    await ensureGalyaClass();
    const occurrences = Array.from({ length: 104 }, (_, index) => {
      const day = new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10);
      return { starts_at: `${day}T09:00`, ends_at: `${day}T10:00` };
    });
    await asAuthenticated(CLAIMS_G, async (client) => {
      expect((await quote(client, CLASS_G, occurrences)).occurrences).toHaveLength(104);
      await expectRejected(client, () => quote(client, CLASS_G, [...occurrences, {
        starts_at: '2027-01-17T09:00', ends_at: '2027-01-17T10:00',
      }]), /invalid_occurrences/);
      await expectRejected(client, () => quote(client, CLASS_G, [occurrences[0], occurrences[0]]), /duplicate_occurrence/);
      await expectRejected(client, () => quote(client, CLASS_G, [
        { starts_at: '2026-10-05T09:15', ends_at: '2026-10-05T10:00' },
      ]), /invalid_local_range/);
    });
    await asAuthenticated(CLAIMS_G, async (client) => {
      await expectRejected(client, () => quote(client, CLASS_E, [
        { starts_at: '2026-10-05T09:00', ends_at: '2026-10-05T10:00' },
      ]), /class_forbidden/);
    });
    const owner = await db();
    try {
      await owner.query('update public.classes set active = false where id = $1', [CLASS_G]);
    } finally {
      owner.release();
    }
    await asAuthenticated(CLAIMS_G, async (client) => {
      await expectRejected(client, () => quote(client, CLASS_G, [
        { starts_at: '2026-10-05T09:00', ends_at: '2026-10-05T10:00' },
      ]), /active_class_required/);
    });
    await ensureGalyaClass();
  });

  test('serializes simultaneous overlapping series so the losing transaction inserts no rows', async () => {
    await ensureGalyaClass();
    const pool = new pg.Pool({
      connectionString: process.env.SUPABASE_DB_URL,
      statement_timeout: 15000,
      max: 3,
    });
    const winner = await pool.connect();
    const contender = await pool.connect();
    const observer = await pool.connect();
    try {
      for (const client of [winner, contender]) {
        await client.query('begin');
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(CLAIMS_G)]);
        await client.query('set local role authenticated');
      }
      const occurrence = [{ starts_at: '2026-10-28T09:00', ends_at: '2026-10-28T10:00' }];
      await create(winner, CLASS_G, occurrence);
      const losingInsert = create(contender, CLASS_G, occurrence);
      let lockSeen = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const { rows } = await observer.query(
          `select wait_event_type from pg_stat_activity where pid = $1`, [contender.processID],
        );
        if (rows[0]?.wait_event_type === 'Lock') { lockSeen = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lockSeen).toBe(true);
      await winner.query('commit');
      await expect(losingInsert).rejects.toThrow(/booking_conflict/);
      await contender.query('rollback');
      const verify = await db();
      try {
        const { rows } = await verify.query(
          `select count(*)::int as count from public.bookings
           where class_id = $1 and starts_at = '2026-10-28T09:00'::timestamp`, [CLASS_G],
        );
        expect(rows[0].count).toBe(1);
      } finally {
        verify.release();
      }
    } finally {
      await winner.query('rollback').catch(() => {});
      await contender.query('rollback').catch(() => {});
      winner.release(); contender.release(); observer.release();
      await pool.end();
    }
  });
});
