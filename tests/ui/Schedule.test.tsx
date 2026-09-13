import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Schedule from '../../src/components/Schedule';
import type { DaySchedule } from '../../src/lib/types';

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
