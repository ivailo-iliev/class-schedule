import { describe, expect, test, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/session', () => ({
  getSupabaseClient: () => ({ rpc, from: () => { throw new Error('base table reads are forbidden for getWeek'); } }),
  clearSession: vi.fn(),
  isSessionRevokedError: () => false,
}));

import { getWeek } from '../../src/lib/api';
import { daySlots } from '../../src/lib/calendar';

describe('getWeek', () => {
  test('uses exactly one get_week RPC and maps the complete safe weekly projection', async () => {
    rpc.mockResolvedValueOnce({ data: {
      week_start: '2026-11-02',
      week_end: '2026-11-08',
      days: Array.from({ length: 7 }, (_, index) => {
        const date = `2026-11-${String(2 + index).padStart(2, '0')}`;
        return {
          date,
          bookings: index === 0 ? [{ id: 'b1', room: 'hall', starts_at: '2026-11-02T08:30:00', ends_at: '2026-11-02T09:00:00', teacher_name: 'Елеонора', activity_title: 'Йога', can_manage: true }] : [],
          slot_prices: index === 0 ? [{ starts_at: '2026-11-02T08:30:00', price: '5.00', currency: 'EUR' }] : [],
        };
      }),
    }, error: null });

    await expect(getWeek('2026-11-05')).resolves.toMatchObject({
      weekStart: '2026-11-02',
      weekEnd: '2026-11-08',
      days: [
        { date: '2026-11-02', slots: daySlots('2026-11-02'), bookings: [{ id: 'b1', startsAt: '2026-11-02T08:30:00', endsAt: '2026-11-02T09:00:00' }], slotPrices: [{ startsAt: '2026-11-02T08:30:00', price: '5.00', currency: 'EUR' }] },
        ...Array.from({ length: 6 }, (_, index) => ({ date: `2026-11-${String(3 + index).padStart(2, '0')}`, bookings: [], slots: daySlots(`2026-11-${String(3 + index).padStart(2, '0')}`), slotPrices: [] })),
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_week', { p_date: '2026-11-05' });
  });

  test.each([
    ['bad week start', { week_start: '2026-11-03' }],
    ['bad week end', { week_end: '2026-11-07' }],
    ['bad day count', { days: [] }],
    ['bad day order', { days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-11-${String(index === 0 ? 3 : index + 2).padStart(2, '0')}`, bookings: [] })) }],
    ['bad bookings', { days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-11-${String(2 + index).padStart(2, '0')}`, bookings: index === 0 ? null : [] })) }],
  ])('rejects %s without a base-table fallback', async (_label, changes) => {
    rpc.mockResolvedValueOnce({ data: {
      week_start: '2026-11-02', week_end: '2026-11-08',
      days: Array.from({ length: 7 }, (_, index) => ({ date: `2026-11-${String(2 + index).padStart(2, '0')}`, bookings: [] })),
      ...changes,
    }, error: null });
    await expect(getWeek('2026-11-05')).rejects.toThrow('invalid_week_response');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
