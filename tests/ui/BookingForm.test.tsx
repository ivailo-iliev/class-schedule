import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BookingForm from '../../src/components/BookingForm';
import type { Booking, ClassItem, Profile } from '../../src/lib/types';

const teacher: Profile = { id: 'teacher-a', name: 'Teacher A', role: 'teacher' };
const otherTeacher: Profile = { id: 'teacher-b', name: 'Teacher B', role: 'teacher' };

function classItem(overrides: Partial<ClassItem> = {}): ClassItem {
  return {
    id: 'class-a',
    teacherId: teacher.id,
    name: 'Pilates',
    active: true,
    ...overrides,
  };
}

function booking(): Booking {
  return {
    id: 'booking-1',
    classId: 'class-a',
    teacherId: teacher.id,
    className: 'Pilates',
    teacherName: 'Teacher A',
    room: 'room_1',
    startsAt: '2026-09-15T15:00:00.000Z',
    hour: 18,
    cancelledAt: null,
    version: 1,
    canEdit: true,
  };
}

function renderForm(
  classes: ClassItem[] = [classItem()],
  overrides: Partial<React.ComponentProps<typeof BookingForm>> = {},
) {
  return render(
    <BookingForm
      date="2026-09-15"
      hour={18}
      room="room_1"
      profile={teacher}
      loadClasses={vi.fn(async () => classes)}
      submitBooking={vi.fn(async () => [booking()])}
      onDone={vi.fn()}
      {...overrides}
    />,
  );
}

describe('BookingForm one-off flow', () => {
  test('prefills the selected date, hour, and room', async () => {
    renderForm();

    expect(await screen.findByRole('combobox', { name: 'Class' })).toBeInTheDocument();
    expect(screen.getByLabelText('Booking date')).toHaveValue('2026-09-15');
    expect(screen.getByLabelText('Booking hour')).toHaveValue(18);
    expect(screen.getByRole('combobox', { name: 'Room' })).toHaveValue('room_1');
  });

  test('offers only the current teacher active classes', async () => {
    renderForm([
      classItem(),
      classItem({ id: 'class-inactive', name: 'Old class', active: false }),
      classItem({ id: 'class-other', name: 'Teacher B class', teacherId: otherTeacher.id }),
    ]);

    expect(await screen.findByRole('option', { name: 'Pilates' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Old class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Teacher B class' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /class title/i })).not.toBeInTheDocument();
  });

  test('explains that a class must be created before booking when none are active', async () => {
    renderForm([
      classItem({ active: false }),
      classItem({ id: 'class-other', teacherId: otherTeacher.id, name: 'Other class' }),
    ]);

    expect(await screen.findByText('Create an active class before booking a room.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Book slot' })).not.toBeInTheDocument();
  });

  test('disables duplicate submissions until the booking request settles', async () => {
    let resolveSubmit!: (value: Booking[]) => void;
    const submit = vi.fn(() => new Promise<Booking[]>((resolve) => { resolveSubmit = resolve; }));
    renderForm([classItem()], { submitBooking: submit });
    await screen.findByRole('option', { name: 'Pilates' });

    fireEvent.click(screen.getByRole('button', { name: 'Book slot' }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Booking…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Booking…' }));
    expect(submit).toHaveBeenCalledTimes(1);

    resolveSubmit([booking()]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book slot' })).toBeInTheDocument());
  });

  test('shows a conflict without clearing the selected form values', async () => {
    const submit = vi.fn(async () => {
      throw { code: 'PT409', message: 'booking_conflict', details: ['2026-09-15T15:00:00.000Z'] };
    });
    renderForm([classItem()], { submitBooking: submit });
    await screen.findByRole('option', { name: 'Pilates' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Class' }), { target: { value: 'class-a' } });

    fireEvent.click(screen.getByRole('button', { name: 'Book slot' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('this slot is no longer available');
    expect(screen.getByRole('combobox', { name: 'Class' })).toHaveValue('class-a');
    expect(screen.getByLabelText('Booking date')).toHaveValue('2026-09-15');
    expect(screen.getByLabelText('Booking hour')).toHaveValue(18);
    expect(screen.getByRole('combobox', { name: 'Room' })).toHaveValue('room_1');
  });
});

describe('BookingForm weekly flow', () => {
  test('reveals bounded weekly controls and all-or-nothing guidance', async () => {
    renderForm();
    await screen.findByRole('option', { name: 'Pilates' });

    fireEvent.click(screen.getByRole('checkbox', { name: /book weekly/i }));

    expect(screen.getByLabelText(/first booking date/i)).toHaveValue('2026-09-15');
    expect(screen.getByRole('combobox', { name: 'Weekday' })).toHaveValue('2');
    expect(screen.getByLabelText(/number of weekly bookings/i)).toHaveAttribute('min', '1');
    expect(screen.getByLabelText(/number of weekly bookings/i)).toHaveAttribute('max', '104');
    expect(screen.getByLabelText(/number of weekly bookings/i)).toHaveAttribute('step', '1');
    expect(screen.getByText(/all weekly bookings succeed or none are created/i)).toBeInTheDocument();
  });

  test('rejects a weekday that does not match the first date', async () => {
    const submit = vi.fn(async () => [booking(), booking()]);
    renderForm([classItem()], { submitBooking: submit });
    await screen.findByRole('option', { name: 'Pilates' });
    fireEvent.click(screen.getByRole('checkbox', { name: /book weekly/i }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Weekday' }), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/number of weekly bookings/i), { target: { value: '2' } });

    fireEvent.click(screen.getByRole('button', { name: /book weekly/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/weekday.*match.*date/i);
    expect(submit).not.toHaveBeenCalled();
  });

  test('submits weekly values and reports the returned count', async () => {
    const submit = vi.fn(async () => [booking(), { ...booking(), id: 'booking-2' }]);
    const onDone = vi.fn();
    renderForm([classItem()], { submitBooking: submit, onDone });
    await screen.findByRole('option', { name: 'Pilates' });
    fireEvent.click(screen.getByRole('checkbox', { name: /book weekly/i }));
    fireEvent.change(screen.getByLabelText(/number of weekly bookings/i), { target: { value: '2' } });

    fireEvent.click(screen.getByRole('button', { name: /book weekly/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith('class-a', 'room_1', '2026-09-15', 18, 2, 2);
    expect(await screen.findByRole('status')).toHaveTextContent('Created 2 weekly bookings.');
  });

  test('keeps weekly inputs and displays returned conflict dates', async () => {
    const submit = vi.fn(async () => {
      throw { code: 'PT409', message: 'booking_conflict', details: [
        '2026-09-22T15:00:00.000Z', '2026-10-06T16:00:00.000Z',
      ] };
    });
    renderForm([classItem()], { submitBooking: submit });
    await screen.findByRole('option', { name: 'Pilates' });
    fireEvent.click(screen.getByRole('checkbox', { name: /book weekly/i }));
    fireEvent.change(screen.getByLabelText(/number of weekly bookings/i), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: /book weekly/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/2026-09-22/);
    expect(screen.getByRole('alert')).toHaveTextContent(/2026-10-06/);
    expect(screen.getByLabelText(/number of weekly bookings/i)).toHaveValue(3);
    expect(screen.getByRole('combobox', { name: 'Weekday' })).toHaveValue('2');
  });

  test('does not report success when the RPC returns fewer bookings than requested', async () => {
    const submit = vi.fn(async () => [booking()]);
    const onDone = vi.fn();
    renderForm([classItem()], { submitBooking: submit, onDone });
    await screen.findByRole('option', { name: 'Pilates' });
    fireEvent.click(screen.getByRole('checkbox', { name: /book weekly/i }));
    fireEvent.change(screen.getByLabelText(/number of weekly bookings/i), { target: { value: '2' } });

    fireEvent.click(screen.getByRole('button', { name: /book weekly/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/expected 2.*received 1/i);
    expect(onDone).not.toHaveBeenCalled();
  });
});
