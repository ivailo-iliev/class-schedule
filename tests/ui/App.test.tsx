import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { addCalendarDays, daySlots } from '../../src/lib/calendar';

function weekFor(date: string) { const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; const start = addCalendarDays(date, -weekday); return { weekStart: start, weekEnd: addCalendarDays(start, 6), days: Array.from({ length: 7 }, (_, index) => ({ date: addCalendarDays(start, index), slots: daySlots(addCalendarDays(start, index)), bookings: [] })) }; }
const mocks = vi.hoisted(() => ({ getWeek: vi.fn(), getMyMonthReport: vi.fn(), getAdminMonthReport: vi.fn(), getTeachers: vi.fn(), bootstrap: vi.fn(), auth: vi.fn(), profile: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ getWeek: mocks.getWeek, getMyMonthReport: mocks.getMyMonthReport, getAdminMonthReport: mocks.getAdminMonthReport, getTeachers: mocks.getTeachers, getMyClasses: vi.fn(), createClass: vi.fn(), updateClass: vi.fn(), scheduleBookings: vi.fn(), editBooking: vi.fn(), cancelBooking: vi.fn() }));
vi.mock('../../src/lib/session', () => ({ bootstrapNativeSession: mocks.bootstrap, onNativeAuthStateChange: mocks.auth, getProfile: mocks.profile }));

describe('App schedule integration', () => {
  beforeEach(() => { mocks.getWeek.mockImplementation(async (date: string) => weekFor(date)); mocks.getMyMonthReport.mockResolvedValue({ month: '2026-11', teacherId: 'teacher', teacherName: 'Teacher', reservationCount: 0, cancelledCount: 0, totalDue: '0.00', rows: [] }); mocks.getAdminMonthReport.mockResolvedValue({ month: '2026-11', teacherId: null, teachers: [], cashboxTotal: '0.00' }); mocks.getTeachers.mockResolvedValue([]); mocks.bootstrap.mockResolvedValue({}); mocks.auth.mockReturnValue({ unsubscribe: vi.fn() }); mocks.profile.mockReturnValue({ id: 'teacher', name: 'Teacher', role: 'teacher' }); });
  test('renders the weekly-backed schedule navigation in Bulgarian', async () => { render(<App />); expect(await screen.findByRole('button', { name: 'График' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Занимания' })).toBeInTheDocument(); expect(screen.getByText('Teacher')).toBeInTheDocument(); expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument(); expect(mocks.getWeek).toHaveBeenCalledTimes(1); });
  test('shows the teacher report destination and only calls the teacher report RPC', async () => { render(<App />); fireEvent.click(await screen.findByRole('button', { name: 'Отчети' })); expect(await screen.findByLabelText('Обобщение на отчета')).toBeInTheDocument(); await waitFor(() => expect(mocks.getMyMonthReport).toHaveBeenCalled()); expect(mocks.getAdminMonthReport).not.toHaveBeenCalled(); });
  test('shows the administrator report and calls its RPC', async () => { mocks.profile.mockReturnValue({ id: 'admin', name: 'Admin', role: 'admin' }); render(<App />); fireEvent.click(await screen.findByRole('button', { name: 'Отчети' })); expect(await screen.findByText('Обща сума в касата')).toBeInTheDocument(); await waitFor(() => expect(mocks.getAdminMonthReport).toHaveBeenCalled()); });
});
