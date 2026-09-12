import pg from 'pg';
const POOL = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL,
  statement_timeout: 10000 });
process.on('beforeExit', () => POOL.end());

export async function db(): Promise<pg.PoolClient> {
  return POOL.connect();
};

export async function asAuthenticated<T>(claims: Record<string, unknown>,
  fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await POOL.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify(claims)]);
    await client.query('SET LOCAL ROLE authenticated');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

export async function withAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return asAuthenticated(
    { sub: 'admin-id', role: 'authenticated', app: 'class-scheduler-v1',
      credential_version: 1 }, fn);
};

export function clean(rows: unknown[]): unknown[] {
  return rows.map((r: Record<string,unknown>) =>
    Object.fromEntries(Object.entries(r)
      .filter(([_,v]) => !(
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) &&
        (v.endsWith('Z') || v.endsWith('+00:00'))
      ))));
};
