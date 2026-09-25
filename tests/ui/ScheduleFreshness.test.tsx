import { afterEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Schedule from '../../src/components/Schedule';
import type { DaySchedule } from '../../src/lib/types';

function scheduleFor(date = '2026-11-02'): DaySchedule {
  return {
    date,
    slots: Array.from({ length: 23 }, (_, index) => {
      const minutes = 8 * 60 + 30 + index * 30;
      return {
        startsAt: `${date}T${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:00`,
      };
    }),
    bookings: [{
      id: 'booking-1',
      classId: '',
      teacherId: '',
      className: 'Йога',
      teacherName: 'Елеонора',
      room: 'hall',
      startsAt: `${date}T08:30:00`,
      endsAt: `${date}T10:00:00`,
      hour: 8,
      cancelledAt: null,
      version: 1,
      canEdit: false,
    }],
  };
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

afterEach(() => setVisibility('visible'));

describe('accuracy-first schedule refresh', () => {
  test('renders Bulgarian rooms, 08:30 half-hour intervals, and a booking across each occupied interval', async () => {
    render(<Schedule initialDate="2026-11-02" loadSchedule={async () => scheduleFor()} />);

    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Стая' })).toBeInTheDocument();
    expect(screen.getByText('08:30')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.queryByText('08:00')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Йога/ })).toHaveStyle({ gridRow: '2 / span 3' });
    expect(screen.queryByRole('button', { name: /Book Зала at 08:30/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Book Зала at 09:00/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Book Зала at 09:30/ })).not.toBeInTheDocument();
  });

  test('revalidates every visibility return without throttling and keeps empty cells non-bookable while pending', async () => {
    let resolveRefresh!: (value: DaySchedule) => void;
    const refresh = new Promise<DaySchedule>((resolve) => { resolveRefresh = resolve; });
    const loader = vi.fn()
      .mockResolvedValueOnce(scheduleFor())
      .mockReturnValueOnce(refresh);
    render(<Schedule initialDate="2026-11-02" loadSchedule={loader} />);
    await screen.findByText('Йога');

    setVisibility('hidden');
    fireEvent(document, new Event('visibilitychange'));
    setVisibility('visible');
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: /Book Стая at 10:00/ })).not.toBeInTheDocument();
    resolveRefresh(scheduleFor());
    expect(await screen.findByRole('button', { name: 'Book Стая at 10:00' })).toBeEnabled();
  });

  test('keeps availability unknown and disabled after a failed refresh', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce(scheduleFor())
      .mockRejectedValueOnce(new Error('offline'));
    render(<Schedule initialDate="2026-11-02" loadSchedule={loader} />);
    await screen.findByText('Йога');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/out of date/i);
    expect(screen.queryByRole('button', { name: /Book / })).not.toBeInTheDocument();
  });

  test('loads on date selection and manual refresh', async () => {
    const loader = vi.fn(async (date: string) => scheduleFor(date));
    render(<Schedule initialDate="2026-11-02" loadSchedule={loader} />);
    await screen.findByText('Йога');
    fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    await waitFor(() => expect(loader).toHaveBeenCalledWith('2026-11-03'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedule' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  });
});
