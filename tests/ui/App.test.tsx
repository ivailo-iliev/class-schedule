import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { addCalendarDays, daySlots } from '../../src/lib/calendar';

function weekFor(date: string) { const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; const start = addCalendarDays(date, -weekday); return { weekStart: start, weekEnd: addCalendarDays(start, 6), days: Array.from({ length: 7 }, (_, index) => ({ date: addCalendarDays(start, index), slots: daySlots(addCalendarDays(start, index)), bookings: [] })) }; }
const mocks = vi.hoisted(() => ({ getWeek: vi.fn(), getMyMonthReport: vi.fn(), getAdminMonthReport: vi.fn(), getTeachers: vi.fn(), getMyClasses: vi.fn(), bootstrap: vi.fn(), auth: vi.fn(), profile: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ getWeek: mocks.getWeek, getMyMonthReport: mocks.getMyMonthReport, getAdminMonthReport: mocks.getAdminMonthReport, getTeachers: mocks.getTeachers, getMyClasses: mocks.getMyClasses, createClass: vi.fn(), updateClass: vi.fn(), scheduleBookings: vi.fn(), editBooking: vi.fn(), cancelBooking: vi.fn() }));
vi.mock('../../src/lib/session', () => ({ bootstrapNativeSession: mocks.bootstrap, onNativeAuthStateChange: mocks.auth, getProfile: mocks.profile }));

describe('App schedule integration', () => {
  beforeEach(() => { mocks.getWeek.mockImplementation(async (date: string) => weekFor(date)); mocks.getMyMonthReport.mockResolvedValue({ month: '2026-11', teacherId: 'teacher', teacherName: 'Teacher', reservationCount: 0, cancelledCount: 0, totalDue: '0.00', rows: [] }); mocks.getAdminMonthReport.mockResolvedValue({ month: '2026-11', teacherId: null, teachers: [], cashboxTotal: '0.00' }); mocks.getTeachers.mockResolvedValue([]); mocks.getMyClasses.mockResolvedValue([{ id: 'class-1', teacherId: 'teacher', name: 'Pilates', active: true }]); mocks.bootstrap.mockResolvedValue({}); mocks.auth.mockReturnValue({ unsubscribe: vi.fn() }); mocks.profile.mockReturnValue({ id: 'teacher', name: 'Teacher', role: 'teacher' }); });
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
