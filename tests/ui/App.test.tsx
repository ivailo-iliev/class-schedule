import { describe, expect, beforeEach, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../src/App';
import type { Booking, DaySchedule } from '../../src/lib/types';

const mocks = vi.hoisted(() => ({
  getDay: vi.fn(),
  cancelBooking: vi.fn(),
  bootstrapNativeSession: vi.fn(),
  onNativeAuthStateChange: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock('../../src/lib/api', () => ({
  getDay: mocks.getDay,
  getMyClasses: vi.fn(async () => []),
  editBooking: vi.fn(),
  cancelBooking: mocks.cancelBooking,
}));

vi.mock('../../src/lib/session', () => ({
  bootstrapNativeSession: mocks.bootstrapNativeSession,
  onNativeAuthStateChange: mocks.onNativeAuthStateChange,
  getProfile: mocks.getProfile,
}));

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-other',
    classId: 'class-other',
    teacherId: 'teacher-b',
    className: 'Other teacher class',
    teacherName: 'Teacher B',
    room: 'room_2',
    startsAt: '2026-03-29T10:00:00+02:00',
    hour: 10,
    cancelledAt: null,
    version: 1,
    canEdit: false,
    ...overrides,
  };
}

function scheduleFor(): DaySchedule {
  const date = '2026-03-29';
  return {
    date,
    slots: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      valid: true,
      startsAt: `${date}T${hour.toString().padStart(2, '0')}:00:00+02:00`,
    })),
    bookings: [
      booking({
        id: 'booking-owned',
        classId: 'class-owned',
        teacherId: 'teacher-a',
        className: 'Owned teacher class',
        teacherName: 'Teacher A',
        room: 'room_1',
        startsAt: `${date}T09:00:00+02:00`,
        hour: 9,
        canEdit: true,
      }),
      booking(),
    ],
  };
}

describe('App booking details integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/access/#test-token');
    mocks.getDay.mockReset();
    mocks.cancelBooking.mockReset();
    mocks.bootstrapNativeSession.mockReset();
    mocks.onNativeAuthStateChange.mockReset();
    mocks.getProfile.mockReset();
    mocks.getDay.mockResolvedValue(scheduleFor());
    mocks.cancelBooking.mockResolvedValue(booking({ cancelledAt: '2026-03-29T08:00:00+02:00' }));
    mocks.bootstrapNativeSession.mockResolvedValue({});
    mocks.onNativeAuthStateChange.mockReturnValue({ unsubscribe: vi.fn() });
    mocks.getProfile.mockReturnValue({ id: 'teacher-a', name: 'Teacher A', role: 'teacher' });
  });

  test('opens owned editable and another-teacher read-only bookings from the schedule', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Owned teacher class/ }));
    const ownedDetails = screen.getByRole('region', { name: 'Booking details' });
    expect(within(ownedDetails).getByText('Editable')).toBeInTheDocument();
    expect(within(ownedDetails).getByRole('button', { name: 'Edit booking' })).toBeInTheDocument();

    fireEvent.click(within(ownedDetails).getByRole('button', { name: 'Close booking details' }));
    fireEvent.click(screen.getByRole('button', { name: /Other teacher class/ }));
    const otherDetails = screen.getByRole('region', { name: 'Booking details' });
    expect(within(otherDetails).getByText('Read-only')).toBeInTheDocument();
    expect(within(otherDetails).queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(within(otherDetails).queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });

  test('refreshes the active schedule after cancelling from details', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Owned teacher class/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    await waitFor(() => expect(mocks.cancelBooking).toHaveBeenCalledWith('booking-owned', 1));
    await waitFor(() => expect(mocks.getDay).toHaveBeenCalledTimes(2));
  });
});
