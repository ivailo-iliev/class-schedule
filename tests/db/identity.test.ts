import { describe, test, expect } from 'vitest';
import { db, asAuthenticated } from './helpers';

const T_A = '11111111-1111-1111-1111-111111111111';
const T_B = '22222222-2222-2222-2222-222222222222';
const ADMIN = '33333333-3333-3333-3333-333333333333';

const VALID_TEACHER_A = {
  sub: T_A, role: 'authenticated',
};
const VALID_ADMIN = {
  sub: ADMIN, role: 'authenticated',
};

describe('actor identity', () => {

  test('actor_id returns valid profile for correct claims', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      const { rows } = await client.query('select private.actor_id()');
      expect(rows[0].actor_id).toBe(T_A);
    });
  });

  test('actor_id ignores unrelated claims', async () => {
    await asAuthenticated(
      { sub: T_A, role: 'authenticated', legacy_claim: 'ignored' },
      async (client) => {
        const { rows } = await client.query('select private.actor_id()');
        expect(rows[0].actor_id).toBe(T_A);
      },
    );
  });

  test('actor_id ignores a legacy credential claim', async () => {
    await asAuthenticated(
      { sub: T_A, role: 'authenticated', legacy_credential: 1 },
      async (client) => {
        const { rows } = await client.query('select private.actor_id()');
        expect(rows[0].actor_id).toBe(T_A);
      },
    );
  });

  test('actor_id ignores a stale legacy credential claim', async () => {
    await asAuthenticated(
      { ...VALID_TEACHER_A, legacy_credential: 99 },
      async (client) => {
        const { rows } = await client.query('select private.actor_id()');
        expect(rows[0].actor_id).toBe(T_A);
      },
    );
  });

  test('actor_id returns null for inactive profile', async () => {
    // Deactivate teacher A through a privileged connection, then restore.
    const c = await db();
    try {
      const snap = await c.query(
        'select active, access_token_hash, credential_version, role from public.profiles where id = $1',
        [T_A],
      );
      await c.query(
        `update public.profiles set active = false where id = $1`,
        [T_A],
      );
      await asAuthenticated(VALID_TEACHER_A, async (client) => {
        const { rows } = await client.query('select private.actor_id()');
        expect(rows[0].actor_id).toBeNull();
      });
      await c.query('alter table public.profiles disable trigger profiles_guard');
      await c.query(
        `update public.profiles
           set active = $1, access_token_hash = $2, credential_version = $3, role = $4
         where id = $5`,
        [snap.rows[0].active, snap.rows[0].access_token_hash,
         snap.rows[0].credential_version, snap.rows[0].role, T_A],
      );
      await c.query('alter table public.profiles enable trigger profiles_guard');
    } finally {
      c.release();
    }
  });

});

describe('admin detection', () => {

  test('is_admin returns true for admin role', async () => {
    await asAuthenticated(VALID_ADMIN, async (client) => {
      const { rows } = await client.query('select private.is_admin()');
      expect(rows[0].is_admin).toBe(true);
    });
  });

  test('is_admin returns false for teacher role', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      const { rows } = await client.query('select private.is_admin()');
      expect(rows[0].is_admin).toBe(false);
    });
  });

});

describe('revocation', () => {

  test('deactivated profile loses schedule access', async () => {
    // Confirm access works while the profile is active.
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      const { rows } = await client.query('select private.actor_id()');
      expect(rows[0].actor_id).toBe(T_A);
    });
    // Deactivate the profile; restore afterwards.
    const c = await db();
    let snapshot: { active: boolean; access_token_hash: string | null; credential_version: number; role: string } | null = null;
    try {
      const snap = await c.query(
        'select active, access_token_hash, credential_version, role from public.profiles where id = $1',
        [T_A],
      );
      snapshot = {
        active: snap.rows[0].active,
        access_token_hash: snap.rows[0].access_token_hash,
        credential_version: snap.rows[0].credential_version,
        role: snap.rows[0].role,
      };
      await c.query(`update public.profiles set active = false where id = $1`, [T_A]);
      // Native sessions lose access when the profile is inactive.
      await asAuthenticated(VALID_TEACHER_A, async (client) => {
        const { rows } = await client.query('select private.actor_id()');
        expect(rows[0].actor_id).toBeNull();
      });
    } finally {
      if (snapshot) {
        await c.query('alter table public.profiles disable trigger profiles_guard');
        await c.query(
          `update public.profiles
             set active = $1, access_token_hash = $2, credential_version = $3, role = $4
           where id = $5`,
          [snapshot.active, snapshot.access_token_hash,
           snapshot.credential_version, snapshot.role, T_A],
        );
        await c.query('alter table public.profiles enable trigger profiles_guard');
      }
      c.release();
    }
  });

});

describe('profile column security', () => {

  test('safe profile columns are readable', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      const { rows } = await client.query(
        'select id, name, role, active from public.profiles order by name',
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const a = rows.find((r: any) => r.name === 'Teacher A');
      expect(a).toBeDefined();
      expect(a!.role).toBe('teacher');
    });
  });

  test('select star on profiles is forbidden', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      await expect(
        client.query('select * from public.profiles'),
      ).rejects.toThrow();
    });
  });

  test('access_token_hash column is invisible to authenticated', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      await expect(
        client.query('select access_token_hash from public.profiles limit 1'),
      ).rejects.toThrow();
    });
  });

  test('credential_version column is invisible to authenticated', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      await expect(
        client.query('select credential_version from public.profiles limit 1'),
      ).rejects.toThrow();
    });
  });

  test('authenticated user cannot update own role', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      await expect(
        client.query(
          `update public.profiles set role = 'admin' where id = $1`,
          [T_A],
        ),
      ).rejects.toThrow();
    });
    // Verify role persisted unchanged
    const c = await db();
    try {
      const { rows } = await c.query(
        'select role::text from public.profiles where id = $1',
        [T_A],
      );
      expect(rows[0].role).toBe('teacher');
    } finally {
      c.release();
    }
  });

  test('authenticated user cannot update own credential fields', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      await expect(
        client.query(
          `update public.profiles set access_token_hash = null where id = $1`,
          [T_A],
        ),
      ).rejects.toThrow();
    });
  });

});

describe('can_manage', () => {

  test('can_manage own id returns true', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      const { rows } = await client.query(
        'select private.can_manage($1)', [T_A],
      );
      expect(rows[0].can_manage).toBe(true);
    });
  });

  test('can_manage other teacher id returns false for teacher', async () => {
    await asAuthenticated(VALID_TEACHER_A, async (client) => {
      const { rows } = await client.query(
        'select private.can_manage($1)', [T_B],
      );
      expect(rows[0].can_manage).toBe(false);
    });
  });

  test('can_manage other teacher id returns true for admin', async () => {
    await asAuthenticated(VALID_ADMIN, async (client) => {
      const { rows } = await client.query(
        'select private.can_manage($1)', [T_B],
      );
      expect(rows[0].can_manage).toBe(true);
    });
  });

});