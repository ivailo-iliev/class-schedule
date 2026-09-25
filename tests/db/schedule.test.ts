import { afterAll, describe, expect, test } from 'vitest';
import { asAuthenticated, db } from './helpers';

const ELEONORA = '11111111-1111-1111-1111-111111111111';
const SILVIA = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const CLASS_E = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLASS_S = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HALL_BOOKING = '90000000-0000-0000-0000-000000000001';
const CANCELLED_BOOKING = '90000000-0000-0000-0000-000000000002';

async function insertScheduleFixtures() {
  const client = await db();
  try {
    await client.query(
      `insert into public.bookings
        (id, class_id, teacher_id, room, starts_at, ends_at, student_details,
         calculated_amount, price_breakdown)
       values
        ($1, $2, $3, 'hall'::public.room, '2026-11-02T08:30'::timestamp,
         '2026-11-02T10:00'::timestamp, 'Private child detail', 15, '[{"label":"private rate"}]'::jsonb),
        ($4, $5, $6, 'room'::public.room, '2026-11-02T10:00'::timestamp,
         '2026-11-02T10:30'::timestamp, 'Cancelled child detail', 5, '[{"label":"private rate"}]'::jsonb)`,
      [HALL_BOOKING, CLASS_E, ELEONORA, CANCELLED_BOOKING, CLASS_S, SILVIA],
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
      [HALL_BOOKING, CANCELLED_BOOKING],
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
      });
      expect(JSON.stringify(schedule)).not.toMatch(/Private child detail|private rate|student_details|amount|segments/i);
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
