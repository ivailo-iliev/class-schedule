import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import BookingDetails from '../../src/components/BookingDetails';
import Schedule from '../../src/components/Schedule';
import type { Booking, DaySchedule } from '../../src/lib/types';

function scheduleFor(date = '2026-03-29'): DaySchedule {
  return {
    date,
    slots: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      valid: hour !== 3,
      startsAt: hour === 3 ? null : `${date}T${hour.toString().padStart(2, '0')}:00:00+02:00`,
    })),
    bookings: [
      {
        id: 'booking-1',
        classId: 'class-1',
        teacherId: 'teacher-b',
        className: 'Very long pilates class title that wraps',
        teacherName: 'Teacher B',
        room: 'room_2',
        startsAt: `${date}T10:00:00+02:00`,
        hour: 10,
        cancelledAt: null,
        version: 1,
        canEdit: false,
      },
    ],
  };
}

function renderLoaded(loader = vi.fn(async (date: string) => scheduleFor(date))) {
  render(<Schedule initialDate="2026-03-29" loadSchedule={loader} />);
  return loader;
}

function renderScheduleWithDetails(schedule: DaySchedule) {
  function ScheduleWithDetails() {
    const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
    return (
      <>
        <Schedule
          initialDate={schedule.date}
          loadSchedule={async () => schedule}
          onSelectBooking={setSelectedBooking}
        />
        {selectedBooking && (
          <BookingDetails
            booking={selectedBooking}
            onClose={() => setSelectedBooking(null)}
            onRefresh={vi.fn(async () => undefined)}
          />
        )}
      </>
    );
  }

  render(<ScheduleWithDetails />);
}

describe('Schedule screen', () => {
  test('shows personal access link prompt when no fragment exists', async () => {
    const { default: App } = await import('../../src/App');
    render(<App />);
    expect(screen.getByText('Open your personal access link')).toBeInTheDocument();
  });

  test('renders two room headings and all 24 hourly labels', async () => {
    renderLoaded();

    expect(await screen.findByRole('heading', { name: 'Room 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Room 2' })).toBeInTheDocument();
    for (let hour = 0; hour < 24; hour += 1) {
      expect(screen.getByText(`${hour.toString().padStart(2, '0')}:00`)).toBeInTheDocument();
    }
  });

  test('offers empty valid slots as book buttons', async () => {
    renderLoaded();

    expect(await screen.findByRole('button', { name: 'Book Room 1 at 10:00' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Book Room 2 at 11:00' })).toBeEnabled();
  });

  test('shows occupied class and teacher without edit controls for another teacher', async () => {
    renderLoaded();

    expect(await screen.findByText('Very long pilates class title that wraps')).toBeInTheDocument();
    expect(screen.getByText('Teacher B')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit.*Teacher B/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel.*Teacher B/i })).not.toBeInTheDocument();
  });

  test('opens editable and another-teacher bookings in their details view', async () => {
    const schedule = scheduleFor();
    schedule.bookings.push({
      ...schedule.bookings[0],
      id: 'booking-owned',
      className: 'Owned yoga class',
      teacherId: 'teacher-a',
      teacherName: 'Teacher A',
      room: 'room_1',
      hour: 9,
      startsAt: '2026-03-29T09:00:00+02:00',
      canEdit: true,
    });
    schedule.bookings.push({
      ...schedule.bookings[0],
      id: 'booking-cancelled',
      className: 'Cancelled yoga class',
      room: 'room_1',
      hour: 11,
      startsAt: '2026-03-29T11:00:00+02:00',
      cancelledAt: '2026-03-28T12:00:00+02:00',
      canEdit: false,
    });
    renderScheduleWithDetails(schedule);

    fireEvent.click(await screen.findByRole('button', { name: /Owned yoga class/ }));
    expect(screen.getByRole('heading', { name: 'Booking details' })).toBeInTheDocument();
    expect(screen.getByText('Editable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit booking' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close booking details' }));
    fireEvent.click(screen.getByRole('button', { name: /Very long pilates class title/ }));
    const details = screen.getByRole('region', { name: 'Booking details' });
    expect(within(details).getByText('Teacher B')).toBeInTheDocument();
    expect(within(details).getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close booking details' }));
    fireEvent.click(screen.getByRole('button', { name: /Cancelled yoga class/ }));
    expect(within(screen.getByRole('region', { name: 'Booking details' })).getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit booking' })).not.toBeInTheDocument();
  });

  test('renders invalid DST starts as disabled non-interactive cells', async () => {
    renderLoaded();

    const invalid = await screen.findAllByLabelText('03:00 unavailable on this date');
    expect(invalid).toHaveLength(2);
    invalid.forEach((cell) => {
      expect(cell).toBeDisabled();
      expect(cell.tagName).toBe('BUTTON');
    });
  });

  test('shows a load error without presenting unknown slots as free', async () => {
    const loader = vi.fn(async () => { throw new Error('offline'); });
    render(<Schedule initialDate="2026-03-29" loadSchedule={loader} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load schedule');
    expect(screen.queryByRole('button', { name: /Book Room/ })).not.toBeInTheDocument();
  });

  test('disables booking writes and explains offline availability', async () => {
    const onSelectSlot = vi.fn();
    render(<Schedule
      initialDate="2026-03-29"
      loadSchedule={async () => scheduleFor()}
      onSelectSlot={onSelectSlot}
      offline
    />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/booking is disabled/i);
    expect(screen.queryByRole('button', { name: /Book Room/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Unavailable offline')).toHaveLength(45);
    expect(onSelectSlot).not.toHaveBeenCalled();
  });

  test('retains a stale read-only schedule after a refresh error', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce(scheduleFor())
      .mockRejectedValueOnce(new Error('offline'));
    render(<Schedule initialDate="2026-03-29" loadSchedule={loader} />);
    await screen.findByText('Teacher B');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedule' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Schedule may be out of date');
    expect(screen.queryByRole('button', { name: /Book Room/ })).not.toBeInTheDocument();
  });

  test('loads on date navigation and explicit refresh', async () => {
    const loader = renderLoaded();
    await screen.findByText('Teacher B');
    expect(loader).toHaveBeenCalledWith('2026-03-29');

    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(loader).toHaveBeenCalledWith('2026-03-30'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedule' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  });
});
