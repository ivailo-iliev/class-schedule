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

    expect(screen.getByRole('region', { name: 'Подробности за резервацията' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Затвори подробностите за резервацията' })).toHaveTextContent('×');
    expect(screen.getByText('Pilates')).toBeInTheDocument();
    expect(screen.getByText('Teacher B')).toBeInTheDocument();
    expect(screen.getByText('Едно занятие')).toBeInTheDocument();
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Промени резервацията' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отмени резервацията' })).not.toBeInTheDocument();
  });

  test('allows an owner to edit one instance with its expected version', async () => {
    const editBooking = vi.fn(async () => booking({ room: 'room', version: 4 }));
    const onRefresh = vi.fn(async () => undefined);
    renderDetails({ editBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Промени резервацията' }));
    expect(await screen.findByRole('heading', { name: 'Промяна на резервация' })).toBeInTheDocument();
    expect(screen.getByText('Teacher A')).toBeInTheDocument();
    expect(screen.getByText('Избрано занятие от серията')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Клас' })).toHaveValue('class-a');
    fireEvent.change(screen.getByRole('combobox', { name: 'Зала' }), { target: { value: 'room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Запази промените' }));

    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-a', 'room', '2026-09-15T18:00:00', '2026-09-15T18:30:00', null,
    ));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Резервацията е променена.');
  });

  test('allows an admin to edit a booking owned by another teacher', async () => {
    const editBooking = vi.fn(async () => booking({ version: 4 }));
    renderDetails({
      profile: admin,
      booking: booking({ canEdit: true, teacherName: 'Teacher B', teacherId: 'teacher-b' }),
      editBooking,
      loadClasses: vi.fn(async () => [{ ...classes[0], teacherId: 'teacher-b' }]),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Промени резервацията' }));
    expect(await screen.findByRole('heading', { name: 'Промяна на резервация' })).toBeInTheDocument();
    expect(screen.getByText('Teacher B')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Клас' })).toHaveValue('class-a');
    fireEvent.click(screen.getByRole('button', { name: 'Запази промените' }));

    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-a', 'hall', '2026-09-15T18:00:00', '2026-09-15T18:30:00', null,
    ));
  });

  test('keeps mutation identity and version authoritative while refresh fills labels', async () => {
    const editBooking = vi.fn(async () => booking({
      classId: 'class-b',
      className: '',
      teacherName: '',
      room: 'room',
      version: 9,
    }));
    const onRefresh = vi.fn(async () => ({
      date: '2026-09-15',
      slots: [],
      bookings: [booking({
        classId: '',
        teacherId: '',
        className: 'Reconciled class',
        teacherName: 'Teacher A',
        room: 'hall',
        version: 0,
      })],
    }));
    renderDetails({
      editBooking,
      onRefresh,
      loadClasses: vi.fn(async () => [...classes, { id: 'class-b', teacherId: 'teacher-a', name: 'New class', active: true }]),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Промени резервацията' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Клас' }), { target: { value: 'class-b' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Зала' }), { target: { value: 'room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Запази промените' }));
    await waitFor(() => expect(editBooking).toHaveBeenCalledWith(
      'booking-1', 3, 'class-b', 'room', '2026-09-15T18:00:00', '2026-09-15T18:30:00', null,
    ));
    expect(await screen.findByText('Reconciled class')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Промени резервацията' }));
    expect(await screen.findByRole('combobox', { name: 'Клас' })).toHaveValue('class-b');
    fireEvent.click(screen.getByRole('button', { name: 'Запази промените' }));
    await waitFor(() => expect(editBooking).toHaveBeenLastCalledWith(
      'booking-1', 9, 'class-b', 'room', '2026-09-15T18:00:00', '2026-09-15T18:30:00', null,
    ));
  });

  test('confirms cancellation with class, date, hour, and room', async () => {
    const cancelBooking = vi.fn(async () => booking({ cancelledAt: '2026-09-15T12:00:00.000Z' }));
    const onRefresh = vi.fn(async () => undefined);
    renderDetails({ cancelBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Pilates');
    expect(dialog).toHaveTextContent('15 септември 2026 г.');
    expect(dialog).toHaveTextContent('18:00');
    expect(dialog).toHaveTextContent('Зала');
    expect(screen.queryByLabelText('Това и следващите занятия')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Потвърди отмяната' }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('booking-1', 3, 'one'));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Резервацията е отменена.');
  });

  test('refreshes after stale or conflicting writes and keeps the detail actionable', async () => {
    const onRefresh = vi.fn(async () => undefined);
    const cancelBooking = vi.fn(async () => {
      throw { code: 'PT409', message: 'stale_booking' };
    });
    renderDetails({ cancelBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    fireEvent.click(screen.getByRole('button', { name: 'Потвърди отмяната' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/променена|обновен/i);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Промени резервацията' })).toBeInTheDocument();
  });

  test('reconciles an unknown cancellation outcome before asking for a retry', async () => {
    const onRefresh = vi.fn(async () => undefined);
    const cancelBooking = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    renderDetails({ cancelBooking, onRefresh });

    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    fireEvent.click(screen.getByRole('button', { name: 'Потвърди отмяната' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/не можа да бъде потвърдена/i);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(cancelBooking).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Отмени резервацията' })).toBeInTheDocument();
  });

  test('renders cancelled history without edit or cancellation controls', () => {
    renderDetails({
      booking: booking({ cancelledAt: '2026-09-15T12:00:00.000Z', canEdit: false }),
    });

    expect(screen.getByText('Едно занятие')).toBeInTheDocument();
    expect(screen.getByText(/Отменена на 15 септември 2026 г./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Промени резервацията' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отмени резервацията' })).not.toBeInTheDocument();
  });

  test('focuses and contains keyboard input in the cancellation confirmation', () => {
    renderDetails();
    const trigger = screen.getByRole('button', { name: 'Отмени резервацията' });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Да отменим ли тази резервация?' });
    const confirm = screen.getByRole('button', { name: 'Потвърди отмяната' });
    const keep = screen.getByRole('button', { name: 'Запази резервацията' });
    const first = screen.getByLabelText('Само това занятие');

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
    const trigger = screen.getByRole('button', { name: 'Отмени резервацията' });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Да отменим ли тази резервация?' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Да отменим ли тази резервация?' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Подробности за резервацията' })).toBeInTheDocument();
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
      <div role="dialog" aria-label="Панел с подробности за резервацията" onKeyDown={parentKeyDown}>
        <BookingDetails booking={booking()} profile={teacher} onClose={onClose} onRefresh={onRefresh} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    const parent = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Панел с подробности за резервацията"]');
    expect(parent).not.toBeNull();
    if (!parent) throw new Error('parent dialog missing');
    expect(parent).toHaveAttribute('aria-hidden', 'true');
    expect(parent).toHaveAttribute('inert');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Да отменим ли тази резервация?' }), { key: 'Escape' });
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(parent).not.toHaveAttribute('aria-hidden');
    expect(parent).not.toHaveAttribute('inert');
  });

  test('keeps an owned booking readable but disables writes offline', () => {
    const editBooking = vi.fn();
    const cancelBooking = vi.fn();
    renderDetails({ offline: true, editBooking, cancelBooking });

    expect(screen.getByText('Едно занятие')).toBeInTheDocument();
    expect(screen.queryByText('Version')).not.toBeInTheDocument();
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/промяната и отмяната са изключени/i);
    expect(screen.queryByRole('button', { name: 'Промени резервацията' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отмени резервацията' })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    const future = screen.getByLabelText('Това и следващите занятия');
    expect(future).toBeInTheDocument();
    fireEvent.click(future);
    fireEvent.click(screen.getByRole('button', { name: 'Потвърди отмяната' }));
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith('booking-1', 4, 'future'));
    expect(await screen.findByRole('status')).toHaveTextContent(/следващите занятия от серията са отменени/i);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  test('keeps teacher and series identity visible while editing an authorized occurrence', async () => {
    const loadDetails = vi.fn(async () => detail({ version: 4 }));
    renderDetails({ booking: booking({ version: 0 }), loadDetails });

    expect(await screen.findByText('Private student note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Промени резервацията' }));

    expect(await screen.findByRole('heading', { name: 'Промяна на резервация' })).toBeInTheDocument();
    expect(screen.getByText('Teacher A')).toBeInTheDocument();
    expect(screen.getByText('Занятие 2 от серия series-1')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Клас' })).toHaveValue('class-a');
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
    expect(screen.queryByText(/Запазена сума/)).not.toBeInTheDocument();
  });

  test('reports an idempotent cancellation after refreshing the schedule', async () => {
    const cancelBooking = vi.fn(async () => ({ bookings: [], cancelledCount: 0 }));
    const onRefresh = vi.fn(async () => undefined);
    const loadDetails = vi.fn()
      .mockResolvedValueOnce(detail({ version: 4 }))
      .mockResolvedValueOnce(detail({ cancelledAt: '2026-09-15T12:00:00.000Z', canEdit: false, version: 4 }));
    renderDetails({ cancelBooking, onRefresh, loadDetails });

    await screen.findByText('Private student note');
    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    fireEvent.click(screen.getByRole('button', { name: 'Потвърди отмяната' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/вече е била отменена/i);
    expect(cancelBooking).toHaveBeenCalledWith('booking-1', 4, 'one');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(loadDetails).toHaveBeenCalledWith('booking-1');
    expect(screen.queryByRole('button', { name: 'Промени резервацията' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отмени резервацията' })).not.toBeInTheDocument();
  });
});
