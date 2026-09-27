import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { addCalendarDays, daySlots } from '../../src/lib/calendar';
import type { Booking } from '../../src/lib/types';

const appStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
let appStyleElement: HTMLStyleElement;

function weekFor(date: string) { const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; const start = addCalendarDays(date, -weekday); return { weekStart: start, weekEnd: addCalendarDays(start, 6), days: Array.from({ length: 7 }, (_, index) => ({ date: addCalendarDays(start, index), slots: daySlots(addCalendarDays(start, index)), bookings: [] })) }; }
function bookingFor(date: string): Booking { return { id: 'booking-1', classId: 'class-1', teacherId: 'teacher', className: 'Pilates', teacherName: 'Teacher', room: 'hall', startsAt: `${date}T10:00:00`, endsAt: `${date}T11:00:00`, hour: 10, cancelledAt: null, version: 3, canEdit: true }; }
const mocks = vi.hoisted(() => ({ getWeek: vi.fn(), getMyMonthReport: vi.fn(), getAdminMonthReport: vi.fn(), getTeachers: vi.fn(), getMyClasses: vi.fn(), getBookingDetails: vi.fn(), quoteBooking: vi.fn(), editBooking: vi.fn(), cancelBooking: vi.fn(), bootstrap: vi.fn(), auth: vi.fn(), profile: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ getWeek: mocks.getWeek, getMyMonthReport: mocks.getMyMonthReport, getAdminMonthReport: mocks.getAdminMonthReport, getTeachers: mocks.getTeachers, getMyClasses: mocks.getMyClasses, getBookingDetails: mocks.getBookingDetails, quoteBooking: mocks.quoteBooking, createClass: vi.fn(), updateClass: vi.fn(), scheduleBookings: vi.fn(), editBooking: mocks.editBooking, cancelBooking: mocks.cancelBooking }));
vi.mock('../../src/lib/session', () => ({ bootstrapNativeSession: mocks.bootstrap, onNativeAuthStateChange: mocks.auth, getProfile: mocks.profile }));

describe('App schedule integration', () => {
  beforeAll(() => {
    appStyleElement = document.createElement('style');
    appStyleElement.textContent = appStyles;
    document.head.append(appStyleElement);
  });

  afterAll(() => appStyleElement.remove());

  beforeEach(() => { mocks.getWeek.mockImplementation(async (date: string) => weekFor(date)); mocks.getMyMonthReport.mockResolvedValue({ month: '2026-11', teacherId: 'teacher', teacherName: 'Teacher', reservationCount: 0, cancelledCount: 0, totalDue: '0.00', rows: [] }); mocks.getAdminMonthReport.mockResolvedValue({ month: '2026-11', teacherId: null, teachers: [], cashboxTotal: '0.00' }); mocks.getTeachers.mockResolvedValue([]); mocks.getMyClasses.mockResolvedValue([{ id: 'class-1', teacherId: 'teacher', name: 'Pilates', active: true }]); mocks.bootstrap.mockResolvedValue({}); mocks.auth.mockReturnValue({ unsubscribe: vi.fn() }); mocks.profile.mockReturnValue({ id: 'teacher', name: 'Teacher', role: 'teacher' }); });

  test('renders the desktop header menu without a bounded inner width', async () => {
    const previousViewportWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    window.dispatchEvent(new Event('resize'));
    try {
      render(<App />);
      await screen.findByRole('button', { name: 'График' });
      const appBarInner = document.querySelector('.app-bar__inner') as HTMLElement;
      expect(appBarInner).toBeInTheDocument();
      expect(getComputedStyle(appBarInner).maxWidth).toBe('none');
      expect(screen.getByRole('button', { name: 'График' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Занимания' })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousViewportWidth });
      window.dispatchEvent(new Event('resize'));
    }
  });

  test('renders the weekly-backed schedule navigation in Bulgarian', async () => { render(<App />); expect(await screen.findByRole('button', { name: 'График' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Занимания' })).toBeInTheDocument(); expect(screen.getByText('Teacher')).toBeInTheDocument(); expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument(); expect(mocks.getWeek).toHaveBeenCalledTimes(1); });
  test('shows the teacher report destination and only calls the teacher report RPC', async () => { render(<App />); fireEvent.click(await screen.findByRole('button', { name: 'Отчети' })); expect(await screen.findByLabelText('Обобщение на отчета')).toBeInTheDocument(); await waitFor(() => expect(mocks.getMyMonthReport).toHaveBeenCalled()); expect(mocks.getAdminMonthReport).not.toHaveBeenCalled(); });
  test('shows the administrator report and calls its RPC', async () => { mocks.profile.mockReturnValue({ id: 'admin', name: 'Admin', role: 'admin' }); render(<App />); fireEvent.click(await screen.findByRole('button', { name: 'Отчети' })); expect(await screen.findByText('Обща сума в касата')).toBeInTheDocument(); await waitFor(() => expect(mocks.getAdminMonthReport).toHaveBeenCalled()); });

  test('refreshes only the active destination through its imperative handle', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Зала' });
    const refresh = screen.getByRole('button', { name: 'Презареди текущия изглед' });
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.getWeek).toHaveBeenCalledTimes(2));
    expect(mocks.getMyClasses).not.toHaveBeenCalled();
    expect(mocks.getMyMonthReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Занимания' }));
    await screen.findByText('Pilates');
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.getMyClasses).toHaveBeenCalledTimes(2));
    expect(mocks.getMyMonthReport).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Отчети' }));
    await screen.findByLabelText('Обобщение на отчета');
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.getMyMonthReport).toHaveBeenCalledTimes(2));
    expect(mocks.getMyClasses).toHaveBeenCalledTimes(2);
    expect(mocks.getWeek).toHaveBeenCalledTimes(2);
  });

  test('disables the single refresh control and ignores duplicate clicks while pending', async () => {
    let resolveRefresh!: (value: ReturnType<typeof weekFor>) => void;
    const pendingRefresh = new Promise<ReturnType<typeof weekFor>>((resolve) => { resolveRefresh = resolve; });
    mocks.getWeek.mockImplementationOnce(async (date: string) => weekFor(date));
    mocks.getWeek.mockImplementationOnce(() => pendingRefresh);
    render(<App />);
    await screen.findByRole('heading', { name: 'Зала' });
    const refresh = screen.getByRole('button', { name: 'Презареди текущия изглед' });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(mocks.getWeek).toHaveBeenCalledTimes(2);
    resolveRefresh(weekFor('2026-11-02'));
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(mocks.getWeek).toHaveBeenCalledTimes(2);
  });

  test('refreshes the active view without invoking a full browser reload', async () => {
    const originalWindow = window;
    const reload = vi.fn();
    vi.stubGlobal('window', new Proxy(originalWindow, {
      get(target, property, receiver) {
        if (property === 'location') return { hash: originalWindow.location.hash, reload };
        return Reflect.get(target, property, receiver);
      },
    }));
    try {
      render(<App />);
      await screen.findByRole('heading', { name: 'Зала' });
      fireEvent.click(screen.getByRole('button', { name: 'Презареди текущия изглед' }));
      await waitFor(() => expect(mocks.getWeek).toHaveBeenCalledTimes(2));
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('keeps the booking dialog open while an existing mutation refreshes through the App schedule handle', async () => {
    const bookedWeek = (date: string) => {
      const result = weekFor(date);
      const day = result.days.find((item) => item.date === date);
      if (!day) throw new Error(`missing booked day for ${date}`);
      day.bookings = [bookingFor(date)];
      return result;
    };
    mocks.getWeek.mockImplementation(async (date: string) => bookedWeek(date));
    mocks.cancelBooking.mockResolvedValue({ bookings: [{ ...bookingFor('2026-01-01'), cancelledAt: '2026-01-01T12:00:00.000Z', canEdit: false }], cancelledCount: 1 });
    render(<App />);

    const booking = await screen.findByRole('button', { name: /Подробности за Pilates/ });
    const scheduleDate = screen.getByText(/^[а-я]{2}, \d+ [а-я]{3}$/).textContent;
    fireEvent.click(booking);
    expect(await screen.findByRole('region', { name: 'Резервация' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отмени резервацията' }));
    fireEvent.click(screen.getByRole('button', { name: 'Потвърди отмяната' }));

    await waitFor(() => expect(mocks.cancelBooking).toHaveBeenCalledWith('booking-1', 3, 'one'));
    await waitFor(() => expect(mocks.getWeek).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: 'Резервация' })).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Резервацията е отменена.');
    expect(screen.getByText(scheduleDate!)).toBeInTheDocument();
  });

  test('keeps schedule controls and unrelated Classes form state during a global refresh', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'Зала' });
    fireEvent.click(screen.getByRole('button', { name: 'Следващ ден' }));
    await waitFor(() => expect(mocks.getWeek).toHaveBeenCalledTimes(2));
    const selectedDate = screen.getByText(/^[а-я]{2}, \d+ [а-я]{3}$/).textContent;
    fireEvent.click(screen.getByRole('button', { name: 'Презареди текущия изглед' }));
    await waitFor(() => expect(mocks.getWeek).toHaveBeenCalledTimes(3));
    expect(screen.getByText(selectedDate!)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Занимания' }));
    await screen.findByText('Pilates');
    const className = screen.getByLabelText('Име на заниманието');
    fireEvent.change(className, { target: { value: 'In progress' } });
    fireEvent.click(screen.getByRole('button', { name: 'Презареди текущия изглед' }));
    await waitFor(() => expect(mocks.getMyClasses).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Име на заниманието')).toHaveValue('In progress');
  });

  test('keeps the selected report month and teacher while refreshing', async () => {
    const teacher = { id: 'teacher-b', name: 'Teacher B', role: 'teacher' as const };
    mocks.profile.mockReturnValue({ id: 'admin', name: 'Admin', role: 'admin' });
    mocks.getTeachers.mockResolvedValue([teacher]);
    mocks.getAdminMonthReport.mockResolvedValue({ month: '2026-11', teacherId: null, teachers: [], cashboxTotal: '0.00' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отчети' }));
    await screen.findByText('Обща сума в касата');
    const month = screen.getByLabelText('Избор на месец');
    fireEvent.change(month, { target: { value: '2026-12' } });
    const teacherPicker = await screen.findByLabelText('Учител');
    fireEvent.change(teacherPicker, { target: { value: teacher.id } });
    await waitFor(() => expect(mocks.getAdminMonthReport).toHaveBeenCalledWith('2026-12', teacher.id));
    fireEvent.click(screen.getByRole('button', { name: 'Презареди текущия изглед' }));
    await waitFor(() => expect(mocks.getAdminMonthReport).toHaveBeenCalledWith('2026-12', teacher.id));
    expect(screen.getByLabelText('Избор на месец')).toHaveValue('2026-12');
    expect(screen.getByLabelText('Учител')).toHaveValue(teacher.id);
  });
});
