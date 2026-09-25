import { beforeEach, describe, expect, test, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/session', () => ({
  getSupabaseClient: () => ({ rpc }),
  clearSession: vi.fn(),
  isSessionRevokedError: () => false,
}));

import { createBookingSeries, quoteBooking } from '../../src/lib/api';

const occurrences = [{ starts_at: '2026-11-02T08:30:00', ends_at: '2026-11-02T09:30:00' }];

describe('booking RPC client contracts', () => {
  beforeEach(() => rpc.mockReset());

  test('quotes local occurrences with the exact server argument shape', async () => {
    rpc.mockResolvedValueOnce({ data: {
      occurrences: [{ ...occurrences[0], occurrence_index: 1, duration_minutes: 60, amount: '10.00', segments: [], conflicts: [] }],
      total_amount: '10.00',
    }, error: null });

    await expect(quoteBooking('class-1', 'hall', occurrences)).resolves.toMatchObject({ total_amount: '10.00' });
    expect(rpc).toHaveBeenCalledWith('quote_booking', {
      p_class_id: 'class-1',
      p_room: 'hall',
      p_occurrences: occurrences,
    });
  });

  test('creates without accepting a client amount or quote token and returns authoritative total', async () => {
    rpc.mockResolvedValueOnce({ data: {
      series_id: 'series-1',
      bookings: [{
        id: 'booking-1', series_id: 'series-1', series_index: 0, teacher_id: 'teacher-1', class_id: 'class-1',
        room: 'hall', starts_at: occurrences[0]!.starts_at, ends_at: occurrences[0]!.ends_at,
        student_details: null, currency: 'EUR', amount: '10.00', segments: [], cancelled_at: null,
        cancelled_by: null, version: 1,
      }],
    }, error: null });

    await expect(createBookingSeries('class-1', 'hall', null, occurrences)).resolves.toMatchObject({
      series_id: 'series-1', total_amount: '10.00',
    });
    expect(rpc).toHaveBeenCalledWith('create_booking_series', {
      p_class_id: 'class-1',
      p_room: 'hall',
      p_student_details: null,
      p_occurrences: occurrences,
    });
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain('amount');
    expect(JSON.stringify(rpc.mock.calls[0])).not.toContain('quote');
  });
});
