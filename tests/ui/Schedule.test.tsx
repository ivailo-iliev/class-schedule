import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { daySlots } from '../../src/lib/calendar';
import Schedule from '../../src/components/Schedule';

describe('Schedule screen', () => {
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

  test('does not offer unknown availability as free after an initial load failure', async () => {
    render(<Schedule initialDate="2026-11-02" loadSchedule={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/не е актуален/i);
    expect(screen.queryByRole('button', { name: /Book / })).not.toBeInTheDocument();
  });
});
