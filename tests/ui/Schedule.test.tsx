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

  test('moves a week at a time in week mode and persists the view', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('2026-09-30');
    expect(localStorage.getItem('schedule-view-mode')).toBe('week');
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

  test('uses an app-bar-and-toolbar sticky offset with a grid-only week scroller', async () => {
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} />);
    await screen.findByRole('grid');
    expect(screen.getByRole('banner')).toHaveClass('schedule-date-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const grid = await screen.findByRole('grid');
    expect(grid).toHaveClass('schedule-grid--week');
    expect(grid.parentElement).toHaveClass('schedule-grid-scroll');
    expect(grid.querySelector('.schedule-grid__corner')).toBeTruthy();
    const shell = grid.closest('.schedule-shell')!;
    expect(shell).toHaveStyle({ '--schedule-grid-sticky-top': 'calc(var(--app-bar-height) + var(--schedule-toolbar-height))' });
    expect(grid.querySelector('.schedule-grid__header')).toBeTruthy();
  });
});
