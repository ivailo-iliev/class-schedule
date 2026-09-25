import { afterAll, describe, expect, test } from 'vitest';
import { asAuthenticated, db } from './helpers';

const TEACHER_A = '11111111-1111-1111-1111-111111111111';
const TEACHER_B = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';
const CLASS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLASS_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ACTIVE_A = '91000000-0000-4000-9000-000000000001';
const CANCELLED_A = '91000000-0000-4000-9000-000000000002';
const ACTIVE_B = '91000000-0000-4000-9000-000000000003';
const OUTSIDE_MONTH = '91000000-0000-4000-9000-000000000004';

async function insertFixtures(): Promise<void> {
  const client = await db();
  try {
    await client.query(`
      insert into public.bookings
        (id, class_id, teacher_id, room, starts_at, ends_at, currency, calculated_amount, price_breakdown)
      values
        ($1, $5, $6, 'hall', '2026-11-05 09:00', '2026-11-05 10:00', 'EUR', 10.00,
          '[{"label":"snapshot A","subtotal":"10.00"}]'::jsonb),
        ($2, $5, $6, 'hall', '2026-11-06 09:00', '2026-11-06 10:00', 'EUR', 20.00,
          '[{"label":"cancelled snapshot","subtotal":"20.00"}]'::jsonb),
        ($3, $7, $8, 'room', '2026-11-07 09:00', '2026-11-07 10:00', 'EUR', 10.00,
          '[{"label":"snapshot B","subtotal":"10.00"}]'::jsonb),
        ($4, $5, $6, 'hall', '2026-12-01 09:00', '2026-12-01 10:00', 'EUR', 99.00,
          '[{"label":"outside month","subtotal":"99.00"}]'::jsonb)
      on conflict (id) do nothing`,
      [ACTIVE_A, CANCELLED_A, ACTIVE_B, OUTSIDE_MONTH, CLASS_A, TEACHER_A, CLASS_B, TEACHER_B],
    );
  } finally {
    client.release();
  }
  await asAuthenticated({ sub: TEACHER_A, role: 'authenticated' }, async (client) => {
    await client.query('select public.cancel_booking($1::uuid, 1, $2)', [CANCELLED_A, 'one']);
  });
}

afterAll(async () => {
  const client = await db();
  try {
    await client.query('delete from public.bookings where id = any($1::uuid[])', [
      [ACTIVE_A, CANCELLED_A, ACTIVE_B, OUTSIDE_MONTH],
    ]);
  } finally {
    client.release();
  }
});

describe('secure monthly report RPCs', () => {
  test('rejects anonymous RPC calls and direct base-table reads', async () => {
    const client = await db();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      await expect(client.query('select public.get_my_month_report($1::date)', ['2026-11-01']))
        .rejects.toMatchObject({ code: '42501' });
      await expect(client.query('select * from public.bookings')).rejects.toThrow();
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  test('filters by local selected month, retains cancelled snapshots, and limits teachers to themselves', async () => {
    await insertFixtures();
    await asAuthenticated({ sub: TEACHER_A, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query('select public.get_my_month_report($1::date) as report', ['2026-11-01']);
      const report = rows[0].report;
      expect(report.reservation_count).toBe(2);
      expect(report.cancelled_count).toBe(1);
      expect(report.total_due).toBe('10.00');
      expect(report.rows.map((row: { id: string }) => row.id).sort()).toEqual([ACTIVE_A, CANCELLED_A].sort());
      const cancelled = report.rows.find((row: { id: string }) => row.id === CANCELLED_A);
      expect(cancelled.calculated_amount).toBe('20.00');
      expect(cancelled.effective_amount_due).toBe('0.00');
      expect(cancelled.price_breakdown[0].label).toBe('cancelled snapshot');
      expect(report.rows.every((row: { teacher_id: string }) => row.teacher_id === TEACHER_A)).toBe(true);
    });
    await asAuthenticated({ sub: TEACHER_B, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query('select public.get_my_month_report($1::date) as report', ['2026-11-01']);
      const report = rows[0].report;
      expect(report.rows.map((row: { id: string }) => row.id)).toEqual([ACTIVE_B]);
      expect(report.rows.some((row: { id: string }) => row.id === ACTIVE_A)).toBe(false);
    });
  });

  test('returns admin all-teacher output and reconciles selected totals with cashbox total', async () => {
    await insertFixtures();
    await asAuthenticated({ sub: ADMIN, role: 'authenticated' }, async (client) => {
      const all = (await client.query('select public.get_admin_month_report($1::date, null::uuid) as report', ['2026-11-01'])).rows[0].report;
      expect(all.teachers.map((teacher: { teacher_id: string }) => teacher.teacher_id))
        .toEqual(expect.arrayContaining([TEACHER_A, TEACHER_B]));
      expect(all.teachers.reduce((sum: number, teacher: { total_due: string }) => sum + Number(teacher.total_due), 0))
        .toBe(Number(all.cashbox_total));
      expect(all.cashbox_total).toBe('20.00');

      const selected = (await client.query(
        'select public.get_admin_month_report($1::date, $2::uuid) as report',
        ['2026-11-01', TEACHER_A],
      )).rows[0].report;
      expect(selected.teachers).toHaveLength(1);
      expect(selected.teachers[0].teacher_id).toBe(TEACHER_A);
      expect(selected.teachers[0].total_due).toBe('10.00');
      expect(selected.cashbox_total).toBe('20.00');
    });
  });

  test('denies admin report output to a teacher', async () => {
    await asAuthenticated({ sub: TEACHER_A, role: 'authenticated' }, async (client) => {
      await expect(client.query('select public.get_admin_month_report($1::date, null::uuid)', ['2026-11-01']))
        .rejects.toMatchObject({ code: '42501' });
    });
  });
});
