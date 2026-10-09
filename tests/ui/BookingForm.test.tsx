import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BookingForm, { buildOccurrences } from '../../src/components/BookingForm';
import { addCalendarDays, isoWeekday, todayCalendarDate } from '../../src/lib/calendar';
import type { BookingOccurrence, BookingQuote, ClassItem, CreatedBookingSeries, Profile } from '../../src/lib/types';

const teacher: Profile = { id: 'teacher-a', name: 'Teacher A', role: 'teacher' };
const teacherB: Profile = { id: 'teacher-b', name: 'Teacher B', role: 'teacher' };
const classes: ClassItem[] = [
  { id: 'class-a', teacherId: teacher.id, name: 'Pilates', active: true },
  { id: 'class-b', teacherId: teacherB.id, name: 'Yoga', active: true },
  { id: 'class-old', teacherId: teacher.id, name: 'Archived', active: false },
];

// Keep booking fixtures in the future without depending on the date CI runs.
const today = todayCalendarDate();
const bookingDate = addCalendarDays(today, 8 - isoWeekday(today));

function quoteFor(occurrences: BookingOccurrence[], conflicts: boolean[] = []): BookingQuote {
  return {
    total_amount: (occurrences.length * 10).toFixed(2),
    occurrences: occurrences.map((occurrence, index) => ({
      ...occurrence,
      occurrence_index: index + 1,
      duration_minutes: 30,
      amount: '10.00',
      conflicts: conflicts[index] ? [{ date: occurrence.starts_at.slice(0, 10), room: 'hall' }] : [],
      segments: [{
        starts_at: occurrence.starts_at,
        ends_at: occurrence.ends_at,
        rule_id: 'rule-1',
        label: 'Standard',
        hourly_rate: '20.00',
        subtotal: '10.00',
      }],
    })),
  };
}

function createdFor(occurrences: BookingOccurrence[]): CreatedBookingSeries {
  return {
    series_id: 'series-1',
    total_amount: (occurrences.length * 10).toFixed(2),
    bookings: occurrences.map((occurrence, index) => ({
      id: `booking-${index}`,
      series_id: 'series-1',
      series_index: index,
      teacher_id: teacher.id,
      class_id: 'class-a',
      room: 'hall',
      starts_at: occurrence.starts_at,
      ends_at: occurrence.ends_at,
      student_details: null,
      currency: 'EUR',
      amount: '10.00',
      segments: [],
      cancelled_at: null,
      cancelled_by: null,
      version: 1,
    })),
  };
}

function renderForm(overrides: Partial<React.ComponentProps<typeof BookingForm>> = {}) {
  const quoteBooking = vi.fn(async (_classId: string, _room: 'hall' | 'room', occurrences: BookingOccurrence[]) => quoteFor(occurrences));
  const createBookingSeries = vi.fn(async (_classId: string, _room: 'hall' | 'room', _details: string | null, occurrences: BookingOccurrence[]) => createdFor(occurrences));
  const onRefresh = vi.fn(async () => undefined);
  render(<BookingForm
    date={bookingDate}
    startsAt={`${bookingDate}T08:30:00`}
    room="hall"
    profile={teacher}
    loadClasses={vi.fn(async () => classes)}
    quoteBooking={quoteBooking}
    createBookingSeries={createBookingSeries}
    onRefresh={onRefresh}
    onDone={vi.fn()}
    {...overrides}
  />);
  return { quoteBooking, createBookingSeries, onRefresh };
}

describe('BookingForm server-quoted creation', () => {
  test('keeps recurring local dates intact through a DST-boundary week', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12));
    try {
      expect(buildOccurrences('recurring', '2027-03-29', '08:30', '09:00', '2027-03-29', [1, 7], '2')).toEqual({
        error: null,
        occurrences: [
          { starts_at: '2027-03-29T08:30:00', ends_at: '2027-03-29T09:00:00' },
          { starts_at: '2027-04-04T08:30:00', ends_at: '2027-04-04T09:00:00' },
          { starts_at: '2027-04-05T08:30:00', ends_at: '2027-04-05T09:00:00' },
          { starts_at: '2027-04-11T08:30:00', ends_at: '2027-04-11T09:00:00' },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('offers only half-hour choices from 08:00 through 22:00 and omits the creation description', async () => {
    renderForm();
    const start = await screen.findByRole('combobox', { name: 'Начален час' });
    const end = screen.getByRole('combobox', { name: 'Краен час' });

    for (const picker of [start, end]) {
      const choices = Array.from(picker.querySelectorAll('option'), (option) => option.value);
      expect(choices).toHaveLength(29);
      expect(choices[0]).toBe('08:00');
      expect(choices.at(-1)).toBe('22:00');
      expect(choices.every((choice) => choice.length === 5 && (choice.endsWith(':00') || choice.endsWith(':30')) && Number(choice.slice(0, 2)) >= 8 && Number(choice.slice(0, 2)) <= 22)).toBe(true);
    }
    expect(screen.getByLabelText('Дата на резервацията')).toHaveAttribute('min', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(start).toHaveValue('08:30');
    expect(end).toHaveValue('09:00');
    expect(screen.queryByText('Преди потвърждението ще получите ценова оферта от сървъра.')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Занимание' })).toBeInTheDocument();
  });

  test('quotes exact local half-hour occurrences and shows segment pricing', async () => {
    const { quoteBooking } = renderForm();
    await waitFor(() => expect(quoteBooking).toHaveBeenCalledWith('class-a', 'hall', [
      { starts_at: `${bookingDate}T08:30:00`, ends_at: `${bookingDate}T09:00:00` },
    ]));
    expect(await screen.findByText('Общо: €10.00')).toBeInTheDocument();
    expect(screen.getByText(/Standard/)).toBeInTheDocument();
    expect(screen.getByText(/Standard.*\/ч/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запази' })).toBeEnabled();
  });

  test('uses the dragged grid end time for the initial booking duration', async () => {
    renderForm({ endsAt: `${bookingDate}T10:00:00` });

    expect(await screen.findByRole('combobox', { name: 'Начален час' })).toHaveValue('08:30');
    expect(screen.getByRole('combobox', { name: 'Краен час' })).toHaveValue('10:00');
  });

  test('materializes recurrence preview and creates exactly the previewed occurrences', async () => {
    const { createBookingSeries, onRefresh } = renderForm();
    await screen.findByText('Общо: €10.00');
    fireEvent.click(screen.getByRole('radio', { name: 'Повтарящо се' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Вторник' }));
    fireEvent.change(screen.getByLabelText('Брой седмици'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByText('4 конкретни занимания')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Запази' }));

    await waitFor(() => expect(createBookingSeries).toHaveBeenCalledTimes(1));
    const occurrences = createBookingSeries.mock.calls[0]![3];
    expect(occurrences).toEqual([
      { starts_at: `${bookingDate}T08:30:00`, ends_at: `${bookingDate}T09:00:00` },
      { starts_at: `${addCalendarDays(bookingDate, 1)}T08:30:00`, ends_at: `${addCalendarDays(bookingDate, 1)}T09:00:00` },
      { starts_at: `${addCalendarDays(bookingDate, 7)}T08:30:00`, ends_at: `${addCalendarDays(bookingDate, 7)}T09:00:00` },
      { starts_at: `${addCalendarDays(bookingDate, 8)}T08:30:00`, ends_at: `${addCalendarDays(bookingDate, 8)}T09:00:00` },
    ]);
    expect(createBookingSeries.mock.calls[0]!.slice(0, 3)).toEqual(['class-a', 'hall', null]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Общо: €40.00');
  });

  test('blocks confirmation for conflicts and missing quote amounts', async () => {
    const quoteBooking = vi.fn(async (_classId: string, _room: 'hall' | 'room', occurrences: BookingOccurrence[]) => ({
      ...quoteFor(occurrences, [true]),
      occurrences: quoteFor(occurrences, [true]).occurrences.map((item) => ({ ...item, amount: null })),
    }));
    const { createBookingSeries } = renderForm({ quoteBooking });
    expect(await screen.findByText('Преди потвърждение е необходима пълна ценова оферта без конфликти.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запази' })).toBeDisabled();
    expect(createBookingSeries).not.toHaveBeenCalled();
  });

  test('limits an administrator to the selected teacher active classes', async () => {
    const admin: Profile = { id: 'admin-1', name: 'Admin', role: 'admin' };
    renderForm({ profile: admin, loadTeachers: vi.fn(async () => [teacher, teacherB]) });
    expect(await screen.findByRole('combobox', { name: 'Учител' })).toHaveValue('teacher-a');
    expect(screen.getByRole('option', { name: 'Pilates' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Yoga' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Учител' }), { target: { value: 'teacher-b' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Yoga' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Pilates' })).not.toBeInTheDocument();
  });
});
