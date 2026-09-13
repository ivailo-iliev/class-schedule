import { describe, test, expect } from 'vitest';
import { db } from './helpers';

async function tableExists(schema: string, name: string, client: pg.PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    `select 1 as ok from information_schema.tables
     where table_schema = $1 and table_name = $2`,
    [schema, name]);
  return rows.length === 1;
}

describe('schema', () => {
  test('profiles classes bookings room_rate exist without annual_rates', async () => {
    const client = await db();
    try {
      expect(await tableExists('public', 'profiles', client)).toBe(true);
      expect(await tableExists('public', 'classes', client)).toBe(true);
      expect(await tableExists('public', 'bookings', client)).toBe(true);
      expect(await tableExists('private', 'room_rate', client)).toBe(true);
      expect(await tableExists('private', 'annual_rates', client)).toBe(false);
    } finally {
      client.release();
    }
  });

  test('forbidden tables do not exist (rooms, class_types, series)', async () => {
    const client = await db();
    try {
      expect(await tableExists('public', 'rooms', client)).toBe(false);
      expect(await tableExists('public', 'class_types', client)).toBe(false);
      expect(await tableExists('public', 'series', client)).toBe(false);
    } finally {
      client.release();
    }
  });

  test('app_role enum has exactly teacher and admin', async () => {
    const client = await db();
    try {
      const { rows } = await client.query(
        `select unnest(enum_range(null::public.app_role))::text as v`);
      expect(rows.map(r => r.v).sort()).toEqual(['admin', 'teacher']);
    } finally {
      client.release();
    }
  });

  test('room type has exactly two values', async () => {
    const client = await db();
    try {
      const { rows } = await client.query(
        `select unnest(enum_range(null::public.room))::text as v`);
      expect(rows.map(r => r.v).sort()).toEqual(['room_1', 'room_2']);
    } finally {
      client.release();
    }
  });
});
