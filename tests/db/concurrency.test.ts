import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

// Deterministic two-client concurrency tests for booking integrity.
//
// Every race below uses explicit promise barriers (never blind sleeps) plus a
// third observer connection that polls pg_stat_activity to confirm the contender
// is genuinely blocked on a Lock wait event before the controller
// commits/rolls back the winner. If the contender is not actually waiting, the
// test fails rather than passing by lucky timing.
//
// Where a scenario provably cannot produce a lock wait (e.g. cancellation sets
// the generated active_slot to NULL, so a concurrent rebook does not conflict on
// the unique index), we assert the observed non-blocking rejection explicitly
// instead of faking a barrier that would never trigger.

const URL = process.env.SUPABASE_DB_URL as string;

// Dedicated fixtures so we never collide with seed (1111..) or other suites
// (recurrence 8888.., bookings 7777.., classes 5555..).
const C_A = '99999999-9999-9999-9999-999999999901'; // teacher, class owner
const C_ADM = '99999999-9999-9999-9999-999999999903'; // admin
const CLASS_C = '99999999-9999-9999-9999-aaaaaaaaaa01';
// Distinct synthetic digests (access_token_hash has a UNIQUE constraint).
const HASH_A = '9999999999999999999999999999999999999999999999999999999999999999';
const HASH_ADM = '8888888888888888888888888888888888888888888888888888888888888888';

const CLAIMS_A = {
  sub: C_A, role: 'authenticated',
};

function makePool() {
  return new pg.Pool({ connectionString: URL, statement_timeout: 15000, max: 4 });
}

// Run a single owner (postgres) query against a throwaway pool. The booking
// trigger (SECURITY INVOKER) permits the postgres role, so direct inserts and
// reads work without JWT claims.
async function ownerQuery<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = makePool();
  const c = await pool.connect();
  try { return await fn(c); }
  finally { c.release(); await pool.end(); }
}

class Barrier {
  private resolveFn?: () => void;
  readonly promise: Promise<void>;
  constructor() { this.promise = new Promise((r) => (this.resolveFn = r)); }
  signal() { this.resolveFn?.(); }
}

async function setActor(client: pg.PoolClient, claims: Record<string, unknown>) {
  await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify(claims),
  ]);
  await client.query('SET LOCAL ROLE authenticated');
}

// Poll pg_stat_activity until the given backend is observed waiting on a Lock.
// Returns true only if a real lock wait was observed within the deadline.
async function observeLockWait(
  obs: pg.PoolClient, pid: number, deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const { rows } = await obs.query(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

interface RaceResult {
  aErr?: Error;
  bErr?: Error;
  blocked: boolean;
}

// Drive a winner(A)/contender(B) race with both clients held in open
// transactions. aBody runs in A's open tx and must signal aReady (by returning)
// before A is committed/rolled back. bBody runs in B's open tx after A has
// acted; B is expected to block on a lock (for the overlap/archive cases) until
// the controller resolves A. The observer proves B is genuinely blocked first.
async function race(opts: {
  aBody: (c: pg.PoolClient) => Promise<void>;
  bBody: (c: pg.PoolClient) => Promise<void>;
  commitA: boolean;
}): Promise<RaceResult> {
  const pool = makePool();
  const ca = await pool.connect();
  const cb = await pool.connect();
  const obs = await pool.connect();
  const bPid = cb.processID!;
  const aReady = new Barrier();
  const aProceed = new Barrier();
  const bDone = new Barrier();
  let aErr: Error | undefined;
  let bErr: Error | undefined;

  const aTask = (async () => {
    try { await opts.aBody(ca); } catch (e) { aErr = e as Error; }
    aReady.signal();
    await aProceed.promise;
  })();
  const bTask = (async () => {
    await aReady.promise;
    try { await opts.bBody(cb); } catch (e) { bErr = e as Error; }
    bDone.signal();
  })();

  await aReady.promise;
  const blocked = await observeLockWait(obs, bPid, 8000);
  if (opts.commitA) await ca.query('COMMIT');
  else await ca.query('ROLLBACK');
  aProceed.signal();
  await bDone.promise;
  await bTask;
  await aTask;

  if (bErr) await cb.query('ROLLBACK').catch(() => {});
  else await cb.query('COMMIT').catch(() => {});
  await ca.query('ROLLBACK').catch(() => {});

  ca.release(); cb.release(); obs.release();
  await pool.end();
  return { aErr, bErr, blocked };
}

function scheduleSql() {
  return `select * from public.schedule_bookings(
    $1::uuid, $2::public.room, $3::date, $4::int, $5::int, $6::int)`;
}

async function seedBooking(date: string, hour: number, room: string): Promise<string> {
  const r = await ownerQuery((c) => c.query(
    `insert into public.bookings (class_id, room, starts_at)
     values ($1, $2, ($3::date + make_time($4,0,0)) at time zone 'Europe/Sofia')
     returning id::text`,
    [CLASS_C, room, date, hour],
  ));
  return r.rows[0].id;
}

async function countActiveSlot(room: string, date: string, hour: number): Promise<number> {
  const r = await ownerQuery((c) => c.query(
    `select count(*)::int as n from public.bookings
     where room = $1 and cancelled_at is null
       and starts_at = (($2::date + make_time($3,0,0)) at time zone 'Europe/Sofia')`,
    [room, date, hour],
  ));
  return r.rows[0].n;
}

async function countClassBookings(): Promise<number> {
  const r = await ownerQuery((c) => c.query(
    `select count(*)::int as n from public.bookings where class_id = $1`,
    [CLASS_C],
  ));
  return r.rows[0].n;
}

async function ensureFixtures() {
  await ownerQuery(async (c) => {
    await c.query(
      `insert into public.profiles (id, name, role, active, access_token_hash) values
        ($1, 'Conc Teacher', 'teacher', true, $3),
        ($2, 'Conc Admin', 'admin', true, $4)
       on conflict (id) do nothing`,
      [C_A, C_ADM, HASH_A, HASH_ADM],
    );
    await c.query(
      `insert into public.classes (id, teacher_id, name, active) values
        ($1, $2, 'Conc Class', true)
       on conflict (id) do nothing`,
      [CLASS_C, C_A],
    );
    // Reset to a clean active class with no bookings for each race.
    await c.query(`update public.classes set active = true where id = $1`, [CLASS_C]);
    await c.query(`delete from public.bookings where class_id = $1`, [CLASS_C]);
  });
}

beforeAll(async () => { await ensureFixtures(); }, 20000);

afterAll(async () => {
  await ownerQuery(async (c) => {
    await c.query('alter table public.bookings disable trigger bookings_guard');
    await c.query('alter table public.classes disable trigger classes_guard');
    await c.query('delete from public.bookings where class_id = $1', [CLASS_C]);
    await c.query('delete from public.classes where id = $1', [CLASS_C]);
    await c.query('delete from public.profiles where id = any($1)', [[C_A, C_ADM]]);
    await c.query('alter table public.classes enable trigger classes_guard');
    await c.query('alter table public.bookings enable trigger bookings_guard');
  });
}, 20000);

describe('booking integrity under concurrent transactions', () => {

  test('overlapping recurrence: committed winner blocks contender, no partial rows', async () => {
    await ensureFixtures();
    const room = 'room_1'; const date = '2026-12-07'; const hour = 10; const n = 3;
    const res = await race({
      commitA: true,
      aBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, n, 1]);
      },
      bBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, n, 1]);
      },
    });
    expect(res.blocked).toBe(true);
    expect(res.bErr).toBeDefined();
    expect(String(res.bErr?.message)).toMatch(/booking_conflict/);
    // Winner committed all N; contender created zero, no partial rows survived.
    expect(await countClassBookings()).toBe(n);
    // The contested slot itself holds exactly one active booking, not zero
    // (loser partial) and not two (double-insert on the same instant).
    expect(await countActiveSlot(room, date, hour)).toBe(1);
  });

  test('overlapping recurrence: rolled-back loser lets contender proceed with all N', async () => {
    await ensureFixtures();
    const room = 'room_1'; const date = '2026-12-07'; const hour = 10; const n = 3;
    const res = await race({
      commitA: false,
      aBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, n, 1]);
      },
      bBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, n, 1]);
      },
    });
    expect(res.blocked).toBe(true);
    expect(res.bErr).toBeUndefined();
    expect(await countClassBookings()).toBe(n);
    // Contender won the whole series: the contested slot holds exactly one
    // active booking from the contender's committed batch (A rolled back).
    expect(await countActiveSlot(room, date, hour)).toBe(1);
  });

  test('cancellation during concurrent rebook: safe rejection, slot later released', async () => {
    await ensureFixtures();
    const room = 'room_1'; const date = '2026-12-08'; const hour = 11;
    const seedId = await seedBooking(date, hour, room);

    // A cancels the seeded booking (uncommitted); B tries to rebook the same
    // slot concurrently. Cancellation sets active_slot to NULL, so B does NOT
    // block on the unique index; instead B's snapshot preflight still sees the
    // (uncommitted-cancelled) booking as active and is rejected cleanly.
    const res = await race({
      commitA: true,
      aBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(`select public.cancel_booking($1::uuid, 1)`, [seedId]);
      },
      bBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, 1, null]);
      },
    });
    expect(res.blocked).toBe(false); // NULL generated column removes the index conflict
    expect(res.bErr).toBeDefined();
    expect(String(res.bErr?.message)).toMatch(/booking_conflict/);
    // The seeded booking is cancelled; the contender created nothing.
    expect(await countClassBookings()).toBe(1);
    expect(await countActiveSlot(room, date, hour)).toBe(0);
  });

  test('archive serializes new booking: archived class rejects contender via parent-row lock', async () => {
    await ensureFixtures();
    const room = 'room_1'; const date = '2026-12-09'; const hour = 12;
    const res = await race({
      commitA: true,
      aBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        // Archive the class: takes a row lock the contender's FOR SHARE must wait on.
        await c.query(`update public.classes set active = false where id = $1`, [CLASS_C]);
      },
      bBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, 1, null]);
      },
    });
    expect(res.blocked).toBe(true);
    expect(res.bErr).toBeDefined();
    expect(String(res.bErr?.message)).toMatch(/active_class_required/);
    expect(await countClassBookings()).toBe(0);
  });

  test('archive race rollback: contender succeeds when archive is rolled back', async () => {
    await ensureFixtures();
    const room = 'room_1'; const date = '2026-12-09'; const hour = 12;
    const res = await race({
      commitA: false,
      aBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(`update public.classes set active = false where id = $1`, [CLASS_C]);
      },
      bBody: async (c) => {
        await c.query('BEGIN');
        await setActor(c, CLAIMS_A);
        await c.query(scheduleSql(), [CLASS_C, room, date, hour, 1, null]);
      },
    });
    expect(res.blocked).toBe(true);
    expect(res.bErr).toBeUndefined();
    expect(await countClassBookings()).toBe(1);
    expect(await countActiveSlot(room, date, hour)).toBe(1);
  });

});
