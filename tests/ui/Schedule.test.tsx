import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addCalendarDays, daySlots } from '../../src/lib/calendar';
import Schedule from '../../src/components/Schedule';
import type { DaySchedule, WeekSchedule } from '../../src/lib/types';

function weekFor(date: string): WeekSchedule {
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = addCalendarDays(date, -weekday);
  const days = Array.from({ length: 7 }, (_, index) => ({ date: addCalendarDays(start, index), slots: daySlots(addCalendarDays(start, index)), bookings: [] })) as WeekSchedule['days'];
  return { weekStart: start, weekEnd: addCalendarDays(start, 6), days };
}

describe('Schedule week cache and views', () => {
  beforeEach(() => localStorage.clear());

  test('uses one weekly request while moving through the loaded week and fetches once at its boundary', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-09-21" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Следващ ден' }));
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Предишен ден' }));
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Предишен ден' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('2026-09-20');
  });

  test('renders both rooms in day view and has a compact destination week action', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Стая' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Покажи седмица' })).toBeInTheDocument();
    expect(screen.getByText('ср, 23 сеп')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    await screen.findByRole('button', { name: 'Покажи ден' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('heading')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Зала' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Стая' }));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('schedule-week-room')).toBe('room');
  });

  test('moves a week at a time, updates the pending target range, and persists the view', async () => {
    let resolveNext!: (week: WeekSchedule) => void; let resolvePrevious!: (week: WeekSchedule) => void;
    const next = new Promise<WeekSchedule>((resolve) => { resolveNext = resolve; }); const previous = new Promise<WeekSchedule>((resolve) => { resolvePrevious = resolve; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor('2026-09-23')).mockReturnValueOnce(next).mockReturnValueOnce(previous);
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('2026-09-30');
    expect(screen.getByText('28 сеп – 4 окт')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 28 сеп – 4 окт');
    resolveNext(weekFor('2026-09-30')); await screen.findByRole('button', { name: 'Резервирай Зала на пн, 28 сеп в 08:30' });
    fireEvent.click(screen.getByRole('button', { name: 'Предишна седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
    expect(loader).toHaveBeenLastCalledWith('2026-09-23');
    expect(screen.getByText('21 сеп – 27 сеп')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп');
    resolvePrevious(weekFor('2026-09-23'));
    expect(localStorage.getItem('schedule-view-mode')).toBe('week');
  });

  test('ignores an obsolete adjacent-week response after returning to the loaded week', async () => {
    let resolveNext!: (week: WeekSchedule) => void;
    const next = new Promise<WeekSchedule>((resolve) => { resolveNext = resolve; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor('2026-09-23')).mockReturnValueOnce(next);
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп');

    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 28 сеп – 4 окт');
    fireEvent.click(screen.getByRole('button', { name: 'Предишна седмица' }));
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп');

    resolveNext(weekFor('2026-09-30'));
    await waitFor(() => expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп'));
    expect(screen.getByRole('button', { name: 'Резервирай Зала на пн, 21 сеп в 08:30' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Резервирай Зала на пн, 28 сеп в 08:30' })).not.toBeInTheDocument();
  });

  test('sends the actual weekday and selected room for week slots and rejects a cross-day drag', async () => {
    const onSelectSlot = vi.fn();
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} onSelectSlot={onSelectSlot} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const monday = await screen.findByRole('button', { name: /Резервирай Зала на пн, 21 сеп.*08:30/i });
    const tuesday = screen.getByRole('button', { name: /Резервирай Зала на вт, 22 сеп.*09:30/i });
    fireEvent.pointerDown(monday, { button: 0, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerEnter(tuesday, { pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerUp(tuesday, { pointerId: 7, pointerType: 'mouse' });
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-21', room: 'hall', startsAt: '2026-09-21T08:30:00' }));
  });

  test('uses each weekday slot timestamp for week booking, price, and selection', async () => {
    const onSelectSlot = vi.fn(); const onSelectBooking = vi.fn();
    const loader = async (date: string) => {
      const result = weekFor(date); const tuesday = result.days[1]!;
      tuesday.bookings = [{ id: 'tuesday-booking', classId: 'class', teacherId: 'teacher', className: 'Пилатес', teacherName: 'Ели', room: 'hall', startsAt: '2026-09-22T08:30:00', endsAt: '2026-09-22T10:00:00', hour: 8, cancelledAt: null, version: 1, canEdit: false }];
      tuesday.slotPrices = [{ startsAt: '2026-09-22T10:00:00', price: '7.00', currency: 'EUR' }]; return result;
    };
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} onSelectSlot={onSelectSlot} onSelectBooking={onSelectBooking} />);
    await screen.findByRole('button', { name: 'Покажи седмица' }); fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const booking = await screen.findByRole('button', { name: /Подробности за Пилатес.*вт, 22 сеп.*08:30/i });
    fireEvent.click(booking); expect(onSelectBooking).toHaveBeenCalledWith(expect.objectContaining({ id: 'tuesday-booking' }));
    const available = screen.getByRole('button', { name: /Резервирай Зала на вт, 22 сеп.*10:00/i });
    expect(available).toHaveTextContent('€7.00'); fireEvent.click(available);
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-22', room: 'hall', startsAt: '2026-09-22T10:00:00' }));
  });

  test('keeps price display and vertical multi-slot selection in day mode', async () => {
    const onSelectSlot = vi.fn();
    const loader = async (date: string) => {
      const result = weekFor(date); const day = result.days.find((item) => item.date === date)!;
      (day as DaySchedule).slotPrices = [{ startsAt: `${date}T08:30:00`, price: '5.00', currency: 'EUR' }]; return result;
    };
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} onSelectSlot={onSelectSlot} />);
    const start = await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });
    const end = screen.getByRole('button', { name: 'Резервирай Зала в 09:30' });
    expect(screen.getAllByText('€5.00')).toHaveLength(2);
    fireEvent.pointerDown(start, { button: 0, pointerId: 9, pointerType: 'mouse' });
    fireEvent.pointerEnter(end, { pointerId: 9, pointerType: 'mouse' });
    fireEvent.pointerUp(end, { pointerId: 9, pointerType: 'mouse' });
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-23', endsAt: '2026-09-23T10:00:00', room: 'hall' }));
  });

  test('keeps the sticky header outside the mobile-only horizontal grid scroller', async () => {
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} />);
    await screen.findByRole('grid');
    expect(screen.getByRole('banner')).toHaveClass('schedule-date-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const grid = await screen.findByRole('grid');
    expect(grid).toHaveClass('schedule-grid--week');
    const scroller = grid.querySelector('.schedule-grid-scroll')!;
    const stickyHeader = grid.querySelector('.schedule-grid__header-clip')!;
    expect(scroller).toBeInTheDocument();
    expect(stickyHeader).toBeInTheDocument();
    expect(scroller.contains(stickyHeader)).toBe(false);
    expect(stickyHeader.contains(scroller)).toBe(false);
    expect(grid.querySelector('.schedule-grid__corner')).toBeTruthy();
    const shell = grid.closest('.schedule-shell')!;
    expect(shell).toHaveStyle({ '--schedule-grid-sticky-top': 'calc(var(--app-bar-height) + var(--schedule-toolbar-height))' });
    expect(stickyHeader).toHaveStyle({ top: 'var(--schedule-grid-sticky-top)' });
    expect(grid.querySelector('.schedule-grid__header')).toBeTruthy();
  });
});
