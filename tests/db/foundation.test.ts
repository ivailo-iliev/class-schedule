import { describe, expect, test } from 'vitest';
import { asAuthenticated, db } from './helpers';

const ELEONORA = '11111111-1111-1111-1111-111111111111';
const SILVIA = '22222222-2222-2222-2222-222222222222';
const GALYA = '44444444-4444-4444-4444-444444444444';

async function inTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>) {
  const client = await db();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

async function expectRejected(client: import('pg').PoolClient, sql: string, params: unknown[]) {
  await client.query('savepoint expected_failure');
  await expect(client.query(sql, params)).rejects.toThrow();
  await client.query('rollback to savepoint expected_failure');
}

describe('database foundation', () => {
  test('uses local booking ranges, hall/room names, and pricing rules', async () => {
    const client = await db();
    try {
      const { rows: roomRows } = await client.query(
        `select unnest(enum_range(null::public.room))::text as value`,
      );
      expect(roomRows.map((row) => row.value).sort()).toEqual(['hall', 'room']);

      const { rows: bookingColumns } = await client.query(
        `select column_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'bookings'`,
      );
      const columns = new Map(bookingColumns.map((row) => [row.column_name, row.data_type]));
      expect(columns.get('starts_at')).toBe('timestamp without time zone');
      expect(columns.get('ends_at')).toBe('timestamp without time zone');
      for (const column of [
        'series_id', 'series_index', 'teacher_id', 'student_details', 'currency',
        'calculated_amount', 'price_breakdown', 'created_by', 'updated_by', 'version',
      ]) expect(columns.has(column)).toBe(true);
      expect(columns.has('access_token_used_at')).toBe(false);
      expect(columns.has('credential_version')).toBe(false);
      expect((await client.query(`select to_regclass('private.pricing_rules')::text as name`)).rows[0].name)
        .toBe('private.pricing_rules');
      expect((await client.query(`select to_regclass('private.room_rate')::text as name`)).rows[0].name)
        .toBeNull();
    } finally {
      client.release();
    }
  });

  test('enforces local half-hour same-date ranges and active overlap exclusions', async () => {
    await inTransaction(async (client) => {
      const classId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const otherClassId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const shared = ['EUR', 10, '[]'];
      const insert = `insert into public.bookings
        (class_id, teacher_id, room, starts_at, ends_at, currency, calculated_amount, price_breakdown)
        values ($1, $2, $3::public.room, $4::timestamp, $5::timestamp, $6, $7, $8::jsonb)`;

      await expectRejected(client, insert,
        [classId, ELEONORA, 'hall', '2026-10-05 09:15', '2026-10-05 10:00', ...shared]);
      await expectRejected(client, insert,
        [classId, ELEONORA, 'hall', '2026-10-05 23:30', '2026-10-06 00:00', ...shared]);
      await client.query(insert,
        [classId, ELEONORA, 'hall', '2026-10-06 09:00', '2026-10-06 10:00', ...shared]);
      await client.query(insert,
        [classId, ELEONORA, 'hall', '2026-10-06 10:00', '2026-10-06 10:30', ...shared]);
      await expectRejected(client, insert,
        [otherClassId, SILVIA, 'hall', '2026-10-06 09:30', '2026-10-06 10:30', ...shared]);
      await expectRejected(client, insert,
        [classId, ELEONORA, 'room', '2026-10-06 09:30', '2026-10-06 10:30', ...shared]);
      await client.query(insert,
        [otherClassId, SILVIA, 'room', '2026-10-06 09:30', '2026-10-06 10:30', ...shared]);
    });
  });

  test('binds active auth users and revokes browser base-table and pricing access', async () => {
    await asAuthenticated({ sub: ELEONORA, role: 'authenticated' }, async (client) => {
      const { rows } = await client.query('select private.actor_id() as actor');
      expect(rows[0].actor).toBe(ELEONORA);
      await expect(client.query('select * from public.bookings')).rejects.toThrow();
      await expect(client.query('select * from private.pricing_rules')).rejects.toThrow();
    });

    const owner = await db();
    try {
      await owner.query('update public.profiles set active = false where id = $1', [ELEONORA]);
      await asAuthenticated({ sub: ELEONORA, role: 'authenticated' }, async (client) => {
        expect((await client.query('select private.actor_id() as actor')).rows[0].actor).toBeNull();
      });
      await owner.query('update public.profiles set active = true where id = $1', [ELEONORA]);
      const { rows } = await owner.query(
        `select has_function_privilege('authenticated', 'private.issue_access_link(uuid)', 'execute') as authenticated_can_issue,
                has_function_privilege('service_role', 'private.issue_access_link(uuid)', 'execute') as service_can_issue`,
      );
      expect(rows[0]).toEqual({ authenticated_can_issue: false, service_can_issue: false });
    } finally {
      owner.release();
    }
  });

  test('seeds standard and teacher pricing by fixed profile ids', async () => {
    const client = await db();
    try {
      const { rows } = await client.query(
        `select teacher_id, label, hourly_rate::text as hourly_rate from private.pricing_rules
          where active order by teacher_id nulls first, label`,
      );
      expect(rows.filter((row) => row.teacher_id === null)).toHaveLength(5);
      expect(rows.filter((row) => row.teacher_id === SILVIA && row.hourly_rate === '10.00')).toHaveLength(1);
      expect(rows.filter((row) => row.teacher_id === GALYA)).toHaveLength(0);
      expect(rows.filter((row) => row.teacher_id === ELEONORA && row.hourly_rate === '0.00')).toHaveLength(2);
    } finally {
      client.release();
    }
  });
});
