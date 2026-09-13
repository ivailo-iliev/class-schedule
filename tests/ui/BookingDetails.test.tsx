import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BookingDetails from '../../src/components/BookingDetails';
import type { Booking, ClassItem, Profile } from '../../src/lib/types';

const teacher: Profile = { id: 'teacher-a', name: 'Teacher A', role: 'teacher' };
const admin: Profile = { id: 'admin', name: 'Admin', role: 'admin' };

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-1',
    classId: 'class-a',
    teacherId: 'teacher-a',
    className: 'Pilates',
    teacherName: 'Teacher A',
    room: 'room_1',
    startsAt: '2026-09-15T15:00:00.000Z',
    hour: 18,
    cancelledAt: null,
    version: 3,
    canEdit: true,
    ...overrides,
  };
}

const classes: ClassItem[] = [{
  id: 'class-a', teacherId: 'teacher-a', name: 'Pilates', active: true,
}];

function renderDetails(overrides: Partial<React.ComponentProps<typeof BookingDetails>> = {}) {
  const onClose = vi.fn();
  const onRefresh = vi.fn(async () => undefined);
  render(
    <BookingDetails
      booking={booking()}
      profile={teacher}
      loadClasses={vi.fn(async () => classes)}
      onClose={onClose}
      onRefresh={onRefresh}
      {...overrides}
    />,
  );
  return { onClose, onRefresh };
}

describe('BookingDetails', () => {
  test('shows another teacher booking as readonly', () => {
    renderDetails({ booking: booking({ canEdit: false, teacherId: 'teacher-b', teacherName: 'Teacher B' }) });

    expect(screen.getByRole('heading', { name: 'Booking details' })).toBeInTheDocument();
    expect(screen.getByText('Pilates')).toBeInTheDocument();
    expect(screen.getByText('Teacher B')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });

  test('allows an owner to edit one instance with its expected version', async () => {
    const editBooking = vi.fn(async () => booking({ room: 'room_2', version: 4 }));
    const onRefresh = vi.fn(async () => undefined);
    renderDetails({ editBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Edit booking' }));
    expect(await screen.findByRole('heading', { name: 'Edit booking' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'room_2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking' }));

    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-a', 'room_2', '2026-09-15', 18,
    ));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Booking updated.');
  });

  test('allows an admin to edit a booking owned by another teacher', async () => {
    const editBooking = vi.fn(async () => booking({ version: 4 }));
    renderDetails({
      profile: admin,
      booking: booking({ canEdit: true, teacherName: 'Teacher B', teacherId: 'teacher-b' }),
      editBooking,
      loadClasses: vi.fn(async () => [{ ...classes[0], teacherId: 'teacher-b' }]),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit booking' }));
    expect(await screen.findByRole('heading', { name: 'Edit booking' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save booking' }));

    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-a', 'room_1', '2026-09-15', 18,
    ));
  });

  test('confirms cancellation with class, date, hour, and room', async () => {
    const cancelBooking = vi.fn(async () => booking({ cancelledAt: '2026-09-15T12:00:00.000Z' }));
    const onRefresh = vi.fn(async () => undefined);
    renderDetails({ cancelBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Pilates');
    expect(dialog).toHaveTextContent('September 15, 2026');
    expect(dialog).toHaveTextContent('18:00');
    expect(dialog).toHaveTextContent('Room 1');

    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('booking-1', 3));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Booking cancelled.');
  });

  test('refreshes after stale or conflicting writes and keeps the detail actionable', async () => {
    const onRefresh = vi.fn(async () => undefined);
    const cancelBooking = vi.fn(async () => {
      throw { code: 'PT409', message: 'stale_booking' };
    });
    renderDetails({ cancelBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/changed|refresh/i);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Edit booking' })).toBeInTheDocument();
  });

  test('reconciles an unknown cancellation outcome before asking for a retry', async () => {
    const onRefresh = vi.fn(async () => undefined);
    const cancelBooking = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    renderDetails({ cancelBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm/i);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(cancelBooking).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeInTheDocument();
  });

  test('renders cancelled history without edit or cancellation controls', () => {
    renderDetails({
      booking: booking({ cancelledAt: '2026-09-15T12:00:00.000Z', canEdit: false }),
    });

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText(/Cancelled on September 15, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });
});
