import { describe, expect, test, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/session', () => ({
  getSupabaseClient: () => ({ rpc, from: () => { throw new Error('base table reads are forbidden for getDay'); } }),
  clearSession: vi.fn(),
  isSessionRevokedError: () => false,
}));

import { getDay } from '../../src/lib/api';

describe('getDay', () => {
  test('uses exactly one get_day RPC and maps only its safe local-time projection', async () => {
    rpc.mockResolvedValueOnce({ data: {
      date: '2026-11-02',
      bookings: [{ id: 'b1', room: 'hall', starts_at: '2026-11-02T08:30:00', ends_at: '2026-11-02T09:00:00', teacher_name: 'Елеонора', activity_title: 'Йога', can_manage: true }],
    }, error: null });

    await expect(getDay('2026-11-02')).resolves.toMatchObject({ bookings: [{ id: 'b1', startsAt: '2026-11-02T08:30:00', endsAt: '2026-11-02T09:00:00' }] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_day', { p_date: '2026-11-02' });
  });
});
