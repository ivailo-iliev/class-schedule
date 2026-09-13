import { describe, expect, beforeEach, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../src/App';
import type { Booking, DaySchedule } from '../../src/lib/types';

const mocks = vi.hoisted(() => ({
  getDay: vi.fn(),
  cancelBooking: vi.fn(),
  editBooking: vi.fn(),
  getMyClasses: vi.fn(),
  bootstrapNativeSession: vi.fn(),
  onNativeAuthStateChange: vi.fn(),
  getProfile: vi.fn(),
}));

vi.mock('../../src/lib/api', () => ({
  getDay: mocks.getDay,
  getMyClasses: mocks.getMyClasses,
  scheduleBookings: vi.fn(),
  editBooking: mocks.editBooking,
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

function scheduleWithOwned(overrides: Partial<Booking>): DaySchedule {
  const schedule = scheduleFor();
  schedule.bookings[0] = { ...schedule.bookings[0], ...overrides };
  return schedule;
}

describe('App booking details integration', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/access/#test-token');
    mocks.getDay.mockReset();
    mocks.cancelBooking.mockReset();
    mocks.editBooking.mockReset();
    mocks.getMyClasses.mockReset();
    mocks.bootstrapNativeSession.mockReset();
    mocks.onNativeAuthStateChange.mockReset();
    mocks.getProfile.mockReset();
    mocks.getDay.mockResolvedValue(scheduleFor());
    mocks.cancelBooking.mockResolvedValue(booking({ cancelledAt: '2026-03-29T08:00:00+02:00' }));
    mocks.editBooking.mockResolvedValue(booking({ room: 'room_2', version: 2 }));
    mocks.getMyClasses.mockResolvedValue([
      { id: 'class-owned', teacherId: 'teacher-a', name: 'Owned teacher class', active: true },
    ]);
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

  test('adds the private credential-free manifest link after native exchange', async () => {
    mocks.getProfile.mockReturnValue({ id: '11111111-1111-4111-8111-111111111111', name: 'Teacher A', role: 'teacher' });
    render(<App />);

    await screen.findByRole('heading', { name: 'Daily schedule' });
    expect(document.head.querySelector('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest?profile=11111111-1111-4111-8111-111111111111',
    );
  });

  test('refreshes the active schedule after cancelling from details', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Owned teacher class/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    await waitFor(() => expect(mocks.cancelBooking).toHaveBeenCalledWith('booking-owned', 1));
    await waitFor(() => expect(mocks.getDay).toHaveBeenCalledTimes(2));
  });

  test('does not show unknown-outcome retry guidance until the active-day reload settles', async () => {
    let resolveRefresh!: (schedule: DaySchedule) => void;
    const refresh = new Promise<DaySchedule>((resolve) => { resolveRefresh = resolve; });
    mocks.getDay.mockReset();
    mocks.getDay.mockResolvedValueOnce(scheduleFor()).mockReturnValueOnce(refresh);
    mocks.cancelBooking.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Owned teacher class/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    await waitFor(() => expect(mocks.cancelBooking).toHaveBeenCalledWith('booking-owned', 1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    resolveRefresh(scheduleFor());
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm/i);
  });

  test('reconciles successful edits from the persisted schedule row before showing success', async () => {
    const persisted = scheduleWithOwned({
      className: 'Persisted reformer',
      teacherName: 'Persisted Teacher',
      teacherId: 'teacher-a',
      room: 'room_2',
      hour: 12,
      startsAt: '2026-03-29T12:00:00+02:00',
      version: 7,
    });
    mocks.getDay.mockReset();
    mocks.getDay.mockResolvedValueOnce(scheduleFor()).mockResolvedValueOnce(persisted);
    mocks.editBooking.mockResolvedValue(booking({
      id: 'booking-owned', className: '', teacherName: '', teacherId: '', room: 'room_2', hour: 12,
      startsAt: '2026-03-29T12:00:00+02:00', version: 7,
    }));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Owned teacher class/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit booking' }));
    await screen.findByRole('heading', { name: 'Edit booking' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'room_2' } });
    fireEvent.change(screen.getByLabelText('Booking hour'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking' }));

    const details = await screen.findByRole('region', { name: 'Booking details' });
    expect(within(details).getByRole('status')).toHaveTextContent('Booking updated.');
    expect(within(details).getByText('Persisted reformer')).toBeInTheDocument();
    expect(within(details).getByText('Persisted Teacher')).toBeInTheDocument();
    expect(within(details).getByText('Room 2')).toBeInTheDocument();
    expect(within(details).getByText('12:00')).toBeInTheDocument();
    expect(within(details).getByText('7')).toBeInTheDocument();
  });

  test('reconciles successful cancellations from the persisted schedule row before showing success', async () => {
    const persisted = scheduleWithOwned({
      className: 'Persisted cancelled class',
      teacherName: 'Persisted Teacher',
      teacherId: 'teacher-a',
      room: 'room_2',
      hour: 11,
      startsAt: '2026-03-29T11:00:00+02:00',
      cancelledAt: '2026-03-29T08:00:00+02:00',
      version: 9,
      canEdit: false,
    });
    mocks.getDay.mockReset();
    mocks.getDay.mockResolvedValueOnce(scheduleFor()).mockResolvedValueOnce(persisted);
    mocks.cancelBooking.mockResolvedValue(booking({
      id: 'booking-owned', className: '', teacherName: '', teacherId: '', room: 'room_2', hour: 11,
      startsAt: '2026-03-29T11:00:00+02:00', cancelledAt: persisted.bookings[0].cancelledAt, version: 9,
      canEdit: false,
    }));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /Owned teacher class/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    const details = await screen.findByRole('region', { name: 'Booking details' });
    expect(within(details).getByRole('status')).toHaveTextContent('Booking cancelled.');
    expect(within(details).getByText('Persisted cancelled class')).toBeInTheDocument();
    expect(within(details).getByText('Persisted Teacher')).toBeInTheDocument();
    expect(within(details).getByText('Room 2')).toBeInTheDocument();
    expect(within(details).getByText('11:00')).toBeInTheDocument();
    expect(within(details).getByText('9')).toBeInTheDocument();
  });
});
