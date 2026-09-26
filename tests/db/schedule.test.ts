import { afterAll, describe, expect, test } from 'vitest';
import { asAuthenticated, db } from './helpers';

const ELEONORA = '11111111-1111-1111-1111-111111111111';
const SILVIA = '22222222-2222-2222-2222-222222222222';
const GALYA = '44444444-4444-4444-4444-444444444444';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const CLASS_E = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLASS_S = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HALL_BOOKING = '90000000-0000-0000-0000-000000000001';
const CANCELLED_BOOKING = '90000000-0000-0000-0000-000000000002';
const SERIES_BOOKING = '90000000-0000-0000-0000-000000000003';
const SERIES_ID = '91000000-0000-0000-0000-000000000001';

async function insertScheduleFixtures() {
  const client = await db();
  try {
    await client.query(
      `insert into public.bookings
        (id, series_id, series_index, class_id, teacher_id, room, starts_at, ends_at, student_details,
         calculated_amount, price_breakdown)
       values
        ($1, $7, 0, $2, $3, 'hall'::public.room, '2026-11-02T08:30'::timestamp,
         '2026-11-02T10:00'::timestamp, 'Private child detail', 15, '[{"label":"private rate"}]'::jsonb),
        ($4, default, default, $5, $6, 'room'::public.room, '2026-11-02T10:00'::timestamp,
         '2026-11-02T10:30'::timestamp, 'Cancelled child detail', 5, '[{"label":"private rate"}]'::jsonb),
        ($8, $7, 1, $2, $3, 'hall'::public.room, '2026-11-03T08:30'::timestamp,
         '2026-11-03T10:00'::timestamp, 'Second child detail', 15, '[{"label":"private rate"}]'::jsonb)`,
      [HALL_BOOKING, CLASS_E, ELEONORA, CANCELLED_BOOKING, CLASS_S, SILVIA, SERIES_ID, SERIES_BOOKING],
    );
    await client.query(
      `update public.bookings set cancelled_at = statement_timestamp()
       where id = $1`, [CANCELLED_BOOKING],
    );
  } finally {
    client.release();
  }
}

afterAll(async () => {
  const client = await db();
  try {
    await client.query('delete from public.bookings where id = any($1::uuid[])', [
      [HALL_BOOKING, CANCELLED_BOOKING, SERIES_BOOKING],
    ]);
  } finally {
    client.release();
  }
});

describe('safe authoritative daily schedule RPCs', () => {
  test('returns one cancellation-free safe schedule projection with local half-hour ranges', async () => {
    await insertScheduleFixtures();
    await asAuthenticated({ sub: ELEONORA, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query(
        `select public.get_day('2026-11-02'::date) as schedule`,
      );
      const schedule = rows[0].schedule;
      expect(schedule).toEqual({
        date: '2026-11-02',
        bookings: [{
          id: HALL_BOOKING,
          room: 'hall',
          starts_at: '2026-11-02T08:30:00',
          ends_at: '2026-11-02T10:00:00',
          teacher_name: 'Елеонора',
          activity_title: 'Morning Yoga',
          can_manage: true,
        }],
        slot_prices: expect.arrayContaining([
          { starts_at: '2026-11-02T08:30:00', price: '5.00', currency: 'EUR' },
        ]),
      });
      expect(schedule.slot_prices).toHaveLength(23);
      expect(JSON.stringify(schedule)).not.toMatch(/Private child detail|private rate|student_details|amount|segments/i);
    });
  });

  test('keeps the schedule readable when a slot has no configured price', async () => {
    await asAuthenticated({ sub: GALYA, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query(`select public.get_day('2026-11-01'::date) as schedule`);
      const schedule = rows[0].schedule;
      expect(schedule.date).toBe('2026-11-01');
      expect(schedule.slot_prices).not.toEqual(expect.arrayContaining([
        { starts_at: '2026-11-01T08:30:00', price: expect.any(String), currency: 'EUR' },
      ]));
    });
  });

  test('denies anonymous day reads and keeps direct browser booking-table reads revoked', async () => {
    const client = await db();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      await expect(client.query(`select public.get_day('2026-11-02'::date)`)).rejects.toThrow();
      await client.query('rollback');
    } finally {
      client.release();
    }

    await asAuthenticated({ sub: ELEONORA, role: 'authenticated' }, async (client) => {
      await expect(client.query('select id, student_details, calculated_amount from public.bookings')).rejects.toThrow();
    });
  });

  test('returns private booking details only to its owner or an administrator', async () => {
    await asAuthenticated({ sub: ELEONORA, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query(`select public.get_booking_details($1) as details`, [HALL_BOOKING]);
      expect(rows[0].details).toMatchObject({
        id: HALL_BOOKING,
        room: 'hall',
        starts_at: '2026-11-02T08:30:00',
        ends_at: '2026-11-02T10:00:00',
        student_details: 'Private child detail',
        amount: '15.00',
        series_total: 2,
      });
    });

    await asAuthenticated({ sub: SILVIA, role: 'authenticated' }, async (client) => {
      await expect(client.query(`select public.get_booking_details($1)`, [HALL_BOOKING])).rejects.toThrow(/booking_forbidden/);
    });

    await asAuthenticated({ sub: ADMIN, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query(`select public.get_booking_details($1) as details`, [HALL_BOOKING]);
      expect(rows[0].details.student_details).toBe('Private child detail');
    });
  });
});
