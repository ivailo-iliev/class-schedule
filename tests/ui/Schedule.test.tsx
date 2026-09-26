import { describe, expect, test } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
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
  test('does not offer unknown availability as free after an initial load failure', async () => {
    render(<Schedule initialDate="2026-11-02" loadSchedule={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/не е актуален/i);
    expect(screen.queryByRole('button', { name: /Book / })).not.toBeInTheDocument();
  });
});
