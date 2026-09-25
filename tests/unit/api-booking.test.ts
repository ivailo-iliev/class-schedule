import { beforeEach, describe, expect, test, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('../../src/lib/session', () => ({
  getSupabaseClient: () => ({ rpc }),
  clearSession: vi.fn(),
  isSessionRevokedError: () => false,
}));

import {
  cancelBooking,
  createBookingSeries,
  editBooking,
  getBookingDetails,
  quoteBooking,
} from '../../src/lib/api';

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

  test('loads private details only through the authorized details RPC projection', async () => {
    rpc.mockResolvedValueOnce({ data: {
      id: 'booking-1', series_id: 'series-1', series_index: 2, teacher_id: 'teacher-1', teacher_name: 'Teacher',
      class_id: 'class-1', activity_title: 'Yoga', room: 'hall', starts_at: '2026-11-02T08:30:00',
      ends_at: '2026-11-02T09:30:00', student_details: 'Student', currency: 'EUR', amount: '10.00',
      segments: [], cancelled_at: null, cancelled_by: null, version: 4, can_manage: true, has_future_active: true,
    }, error: null });

    await expect(getBookingDetails('booking-1')).resolves.toMatchObject({
      id: 'booking-1', studentDetails: 'Student', amount: '10.00', hasFutureActive: true, canEdit: true,
    });
    expect(rpc).toHaveBeenCalledWith('get_booking_details', { p_id: 'booking-1' });
  });

  test('sends exact local edit payload and returns the private mutation projection', async () => {
    rpc.mockResolvedValueOnce({ data: {
      id: 'booking-1', series_id: 'series-1', series_index: 2, teacher_id: 'teacher-1', teacher_name: 'Teacher',
      class_id: 'class-1', activity_title: 'Yoga', room: 'room', starts_at: '2026-11-02T10:00:00',
      ends_at: '2026-11-02T11:00:00', student_details: null, currency: 'EUR', amount: '12.00',
      segments: [], cancelled_at: null, cancelled_by: null, version: 5, can_manage: true, has_future_active: false,
    }, error: null });

    await expect(editBooking('booking-1', 4, 'class-1', 'room', '2026-11-02T10:00:00', '2026-11-02T11:00:00', null))
      .resolves.toMatchObject({ startsAt: '2026-11-02T10:00:00', version: 5 });
    expect(rpc).toHaveBeenCalledWith('edit_booking', {
      p_id: 'booking-1', p_expected_version: 4, p_class_id: 'class-1', p_room: 'room',
      p_starts_at: '2026-11-02T10:00:00', p_ends_at: '2026-11-02T11:00:00', p_student_details: null,
    });
  });

  test('sends cancellation scope and preserves idempotent outcome reporting', async () => {
    rpc.mockResolvedValueOnce({ data: { bookings: [], cancelled_count: 0 }, error: null });

    await expect(cancelBooking('booking-1', 4, 'future')).resolves.toEqual({ bookings: [], cancelledCount: 0 });
    expect(rpc).toHaveBeenCalledWith('cancel_booking', {
      p_id: 'booking-1', p_expected_version: 4, p_scope: 'future',
    });
  });
});
