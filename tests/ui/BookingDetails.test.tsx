import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BookingDetails from '../../src/components/BookingDetails';
import type { Booking, BookingDetail, ClassItem, Profile } from '../../src/lib/types';

const teacher: Profile = { id: 'teacher-a', name: 'Teacher A', role: 'teacher' };
const admin: Profile = { id: 'admin', name: 'Admin', role: 'admin' };

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-1',
    classId: 'class-a',
    teacherId: 'teacher-a',
    className: 'Pilates',
    teacherName: 'Teacher A',
    room: 'hall',
    startsAt: '2026-09-15T15:00:00.000Z',
    hour: 18,
    cancelledAt: null,
    version: 3,
    canEdit: true,
    ...overrides,
  };
}

function detail(overrides: Partial<BookingDetail> = {}): BookingDetail {
  return {
    ...booking(),
    endsAt: '2026-09-15T15:30:00.000Z',
    seriesId: 'series-1',
    seriesIndex: 1,
    studentDetails: 'Private student note',
    currency: 'EUR',
    amount: '12.00',
    segments: [],
    hasFutureActive: false,
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

    expect(screen.getByRole('region', { name: 'Booking details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close booking details' })).toHaveTextContent('×');
    expect(screen.getByText('Pilates')).toBeInTheDocument();
    expect(screen.getByText('Teacher B')).toBeInTheDocument();
    expect(screen.getByText('One booking instance')).toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });

  test('allows an owner to edit one instance with its expected version', async () => {
    const editBooking = vi.fn(async () => booking({ room: 'room', version: 4 }));
    const onRefresh = vi.fn(async () => undefined);
    renderDetails({ editBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Edit booking' }));
    expect(await screen.findByRole('heading', { name: 'Edit booking' })).toBeInTheDocument();
    expect(screen.getByText('Teacher A')).toBeInTheDocument();
    expect(screen.getByText('Selected series occurrence')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Class' })).toHaveValue('class-a');
    fireEvent.change(screen.getByRole('combobox', { name: 'Room' }), { target: { value: 'room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save booking' }));

    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-a', 'room', '2026-09-15T18:00:00', '2026-09-15T18:30:00', null,
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
    expect(screen.getByText('Teacher B')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Class' })).toHaveValue('class-a');
    fireEvent.click(screen.getByRole('button', { name: 'Save booking' }));

    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-a', 'hall', '2026-09-15T18:00:00', '2026-09-15T18:30:00', null,
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
    expect(dialog).toHaveTextContent('Зала');
    expect(screen.queryByLabelText('This and later occurrences')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('booking-1', 3, 'one'));
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

    expect(screen.getByText('One booking instance')).toBeInTheDocument();
    expect(screen.getByText(/Cancelled on September 15, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });

  test('focuses and contains keyboard input in the cancellation confirmation', () => {
    renderDetails();
    const trigger = screen.getByRole('button', { name: 'Cancel booking' });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Cancel this booking?' });
    const confirm = screen.getByRole('button', { name: 'Confirm cancellation' });
    const keep = screen.getByRole('button', { name: 'Keep booking' });
    const first = screen.getByLabelText('Only this occurrence');

    expect(document.activeElement).toBe(confirm);
    keep.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(keep);
  });

  test('Escape dismisses only the confirmation and restores focus to its trigger', () => {
    const { onClose } = renderDetails();
    const trigger = screen.getByRole('button', { name: 'Cancel booking' });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Cancel this booking?' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Cancel this booking?' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Booking details' })).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('makes the parent dialog unavailable while cancellation is open', () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn(async () => undefined);
    const parentKeyDown = vi.fn((event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') onClose();
    });
    render(
      <div role="dialog" aria-label="Booking details panel" onKeyDown={parentKeyDown}>
        <BookingDetails booking={booking()} profile={teacher} onClose={onClose} onRefresh={onRefresh} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    const parent = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Booking details panel"]');
    expect(parent).not.toBeNull();
    if (!parent) throw new Error('parent dialog missing');
    expect(parent).toHaveAttribute('aria-hidden', 'true');
    expect(parent).toHaveAttribute('inert');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Cancel this booking?' }), { key: 'Escape' });
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(parent).not.toHaveAttribute('aria-hidden');
    expect(parent).not.toHaveAttribute('inert');
  });

  test('keeps an owned booking readable but disables writes offline', () => {
    const editBooking = vi.fn();
    const cancelBooking = vi.fn();
    renderDetails({ offline: true, editBooking, cancelBooking });

    expect(screen.getByText('One booking instance')).toBeInTheDocument();
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/editing and cancellation are disabled/i);
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
    expect(editBooking).not.toHaveBeenCalled();
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  test('hydrates authorized private details and offers future scope only when later active rows exist', async () => {
    const loadDetails = vi.fn(async () => detail({ hasFutureActive: true, version: 4 }));
    const cancelBooking = vi.fn(async () => ({
      bookings: [detail({ cancelledAt: '2026-09-15T12:00:00.000Z' })],
      cancelledCount: 2,
    }));
    const onRefresh = vi.fn(async () => undefined);
    renderDetails({ booking: booking({ version: 0 }), loadDetails, cancelBooking, onRefresh });

    expect(await screen.findByText('Private student note')).toBeInTheDocument();
    expect(screen.getByText('EUR 12.00')).toBeInTheDocument();
    expect(loadDetails).toHaveBeenCalledWith('booking-1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    const future = screen.getByLabelText('This and later occurrences');
    expect(future).toBeInTheDocument();
    fireEvent.click(future);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('booking-1', 4, 'future'));
    expect(await screen.findByRole('status')).toHaveTextContent(/later bookings were cancelled/i);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  test('keeps teacher and series identity visible while editing an authorized occurrence', async () => {
    const loadDetails = vi.fn(async () => detail({ version: 4 }));
    renderDetails({ booking: booking({ version: 0 }), loadDetails });

    expect(await screen.findByText('Private student note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit booking' }));

    expect(await screen.findByRole('heading', { name: 'Edit booking' })).toBeInTheDocument();
    expect(screen.getByText('Teacher A')).toBeInTheDocument();
    expect(screen.getByText('2 of series series-1')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Class' })).toHaveValue('class-a');
    expect(screen.queryByRole('combobox', { name: 'Teacher' })).not.toBeInTheDocument();
  });

  test('does not request private details for an unrelated teacher', () => {
    const loadDetails = vi.fn(async () => detail());
    renderDetails({
      booking: booking({ canEdit: false, teacherId: 'teacher-b', teacherName: 'Teacher B' }),
      loadDetails,
    });

    expect(loadDetails).not.toHaveBeenCalled();
    expect(screen.queryByText('Private student note')).not.toBeInTheDocument();
    expect(screen.queryByText(/Snapshot amount/)).not.toBeInTheDocument();
  });

  test('reports an idempotent cancellation after refreshing the schedule', async () => {
    const cancelBooking = vi.fn(async () => ({ bookings: [], cancelledCount: 0 }));
    const onRefresh = vi.fn(async () => undefined);
    const loadDetails = vi.fn()
      .mockResolvedValueOnce(detail({ version: 4 }))
      .mockResolvedValueOnce(detail({ cancelledAt: '2026-09-15T12:00:00.000Z', canEdit: false, version: 4 }));
    renderDetails({ cancelBooking, onRefresh, loadDetails });

    await screen.findByText('Private student note');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/already cancelled/i);
    expect(cancelBooking).toHaveBeenCalledWith('booking-1', 4, 'one');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(loadDetails).toHaveBeenCalledWith('booking-1');
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });
});
