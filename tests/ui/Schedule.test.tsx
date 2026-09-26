import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { daySlots } from '../../src/lib/calendar';
import Schedule from '../../src/components/Schedule';

describe('Schedule screen', () => {
  beforeEach(() => localStorage.clear());

  test('shows the selected date in the picker using the Bulgarian weekday date format', async () => {
    const loadSchedule = async (date: string) => ({ date, slots: [], bookings: [] });
    render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} />);

    expect(await screen.findByText('нд, 27.09.2026 г.')).toBeInTheDocument();
    const picker = screen.getByLabelText('Дата в графика');
    expect(picker).toHaveValue('2026-09-27');
    fireEvent.change(picker, { target: { value: '2026-09-28' } });
    expect(await screen.findByText('пн, 28.09.2026 г.')).toBeInTheDocument();
  });

  test('selects a multi-slot booking by dragging from the start slot to the end slot', async () => {
    const onSelectSlot = vi.fn();
    const loadSchedule = async (date: string) => ({ date, slots: daySlots(date), bookings: [] });
    render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} onSelectSlot={onSelectSlot} />);

    const start = await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });
    const middle = screen.getByRole('button', { name: 'Резервирай Зала в 09:00' });
    const end = screen.getByRole('button', { name: 'Резервирай Зала в 09:30' });
    expect(start).toHaveClass('empty-slot--handle');
    fireEvent.pointerDown(start, { button: 0, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerEnter(middle, { pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerEnter(end, { pointerId: 7, pointerType: 'mouse' });

    expect(end).toHaveClass('empty-slot--selected');
    fireEvent.pointerUp(end, { pointerId: 7, pointerType: 'mouse' });

    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    expect(onSelectSlot).toHaveBeenCalledWith({
      date: '2026-09-27',
      startsAt: '2026-09-27T08:30:00',
      endsAt: '2026-09-27T10:00:00',
      hour: 8,
      room: 'hall',
    });
  });

  test('selects a multi-slot booking with a touch pointer move', async () => {
    const onSelectSlot = vi.fn();
    const loadSchedule = async (date: string) => ({ date, slots: daySlots(date), bookings: [] });
    render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} onSelectSlot={onSelectSlot} />);

    const start = await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });
    const end = screen.getByRole('button', { name: 'Резервирай Зала в 09:30' });
    fireEvent.pointerDown(start, { button: 0, pointerId: 8, pointerType: 'touch' });
    fireEvent.pointerMove(end, { pointerId: 8, pointerType: 'touch' });

    expect(end).toHaveClass('empty-slot--selected');
    fireEvent.pointerUp(end, { pointerId: 8, pointerType: 'touch' });
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ endsAt: '2026-09-27T10:00:00' }));
  });

  test('does not offer unknown availability as free after an initial load failure', async () => {
    render(<Schedule initialDate="2026-11-02" loadSchedule={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/не е актуален/i);
    expect(screen.queryByRole('button', { name: /Book / })).not.toBeInTheDocument();
  });

  test('shows the logged-in teacher price only inside free slots', async () => {
    const loadSchedule = async (date: string) => ({
      date,
      slots: daySlots(date),
      bookings: [{
        id: 'booking-1', classId: 'class-1', teacherId: 'teacher-1', className: 'Йога', teacherName: 'Елеонора',
        room: 'hall' as const, startsAt: `${date}T08:30:00`, endsAt: `${date}T09:00:00`, hour: 8,
        cancelledAt: null, version: 1, canEdit: false,
      }],
      slotPrices: [{ startsAt: `${date}T08:30:00`, price: '5.00', currency: 'EUR' }],
    });
    render(<Schedule initialDate="2026-11-02" loadSchedule={loadSchedule} />);

    expect(await screen.findByText('€5.00')).toBeInTheDocument();
    expect(screen.getAllByText('€5.00')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Йога/ })).not.toHaveTextContent('€5.00');
  });

  test('does not show an error when no slot price is available', async () => {
    const loadSchedule = async (date: string) => ({ date, slots: daySlots(date), bookings: [], slotPrices: [] });
    render(<Schedule initialDate="2026-11-02" loadSchedule={loadSchedule} />);

    expect(await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/€\d/)).not.toBeInTheDocument();
  });

  test('uses pressed room buttons and hides unpressed columns', async () => {
    const loadSchedule = async (date: string) => ({ date, slots: daySlots(date), bookings: [] });
    const firstRender = render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} />);

    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зала' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Стая' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Стая' }));
    expect(screen.queryByRole('heading', { name: 'Стая' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('schedule-visible-rooms')!)).toEqual(['hall']);

    firstRender.unmount();
    const secondRender = render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} />);
    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зала' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Стая' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('heading', { name: 'Стая' })).not.toBeInTheDocument();

    secondRender.unmount();
    localStorage.setItem('schedule-visible-rooms', JSON.stringify(['room']));
    render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} />);
    expect(await screen.findByRole('heading', { name: 'Стая' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Зала' }));
    expect(screen.getByRole('button', { name: 'Резервирай Зала в 08:30' }).parentElement).toHaveStyle({ gridColumn: '2' });
    expect(screen.getByRole('button', { name: 'Резервирай Стая в 08:30' }).parentElement).toHaveStyle({ gridColumn: '3' });
  });

  test('keeps the date and room controls in the schedule toolbar', async () => {
    const loadSchedule = async (date: string) => ({ date, slots: [], bookings: [] });
    render(<Schedule initialDate="2026-09-27" loadSchedule={loadSchedule} />);

    await screen.findByRole('button', { name: 'Зала' });
    expect(screen.getByRole('banner')).toHaveClass('schedule-date-bar');
    expect(screen.getByLabelText('Дата в графика')).toBeInTheDocument();
  });
});
