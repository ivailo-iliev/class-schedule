import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRef } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addCalendarDays, daySlots } from '../../src/lib/calendar';
import Schedule, { type ScheduleHandle } from '../../src/components/Schedule';
import type { WeekSchedule } from '../../src/lib/types';

function weekFor(date = '2026-11-02'): WeekSchedule {
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; const start = addCalendarDays(date, -weekday);
  return { weekStart: start, weekEnd: addCalendarDays(start, 6), days: Array.from({ length: 7 }, (_, index) => ({ date: addCalendarDays(start, index), slots: daySlots(addCalendarDays(start, index)), bookings: index === 0 ? [{ id: 'booking', classId: 'class', teacherId: 'teacher', className: 'Йога', teacherName: 'Елеонора', room: 'hall' as const, startsAt: `${start}T08:30:00`, endsAt: `${start}T10:00:00`, hour: 8, cancelledAt: null, version: 1, canEdit: false }] : [] })) as WeekSchedule['days'] };
}
function setVisibility(value: DocumentVisibilityState) { Object.defineProperty(document, 'visibilityState', { configurable: true, value }); }
afterEach(() => setVisibility('visible'));

describe('accuracy-first weekly schedule refresh', () => {
  test('manual imperative refresh coalesces while pending and preserves the visible grid as non-bookable', async () => {
    let resolve!: (value: WeekSchedule) => void; const pending = new Promise<WeekSchedule>((done) => { resolve = done; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor()).mockReturnValueOnce(pending); const ref = createRef<ScheduleHandle>();
    render(<Schedule ref={ref} initialDate="2026-11-02" loadSchedule={loader} />);
    await screen.findByText('Йога');
    const first = ref.current!.refresh(); const second = ref.current!.refresh();
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Резервирай Стая в 10:00' })).not.toBeInTheDocument();
    resolve(weekFor()); await expect(first).resolves.toMatchObject({ date: '2026-11-02' }); await expect(second).resolves.toMatchObject({ date: '2026-11-02' });
    expect(await screen.findByRole('button', { name: 'Резервирай Стая в 10:00' })).toBeEnabled();
  });

  test('retains old week, warns, and never exposes availability after a failed refresh', async () => {
    const loader = vi.fn().mockResolvedValueOnce(weekFor()).mockRejectedValueOnce(new Error('offline')); const ref = createRef<ScheduleHandle>();
    render(<Schedule ref={ref} initialDate="2026-11-02" loadSchedule={loader} />);
    await screen.findByText('Йога'); await expect(ref.current!.refresh()).rejects.toThrow('offline');
    expect(await screen.findByRole('alert')).toHaveTextContent(/не е актуален/i);
    expect(screen.getByText('Йога')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Резервирай Стая в 10:00' })).not.toBeInTheDocument();
  });

  test('revalidates once on a visible foreground event and does not overlap the following focus event', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-11-02" loadSchedule={loader} />); await screen.findByText('Йога');
    setVisibility('hidden'); fireEvent(document, new Event('visibilitychange')); setVisibility('visible'); fireEvent(document, new Event('visibilitychange')); fireEvent(window, new Event('focus'));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  });
});
