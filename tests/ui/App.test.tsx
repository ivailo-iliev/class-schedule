import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../../src/App';
import { daySlots } from '../../src/lib/calendar';

const mocks = vi.hoisted(() => ({ getDay: vi.fn(), getMyMonthReport: vi.fn(), getAdminMonthReport: vi.fn(), getTeachers: vi.fn(), bootstrap: vi.fn(), auth: vi.fn(), profile: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ getDay: mocks.getDay, getMyMonthReport: mocks.getMyMonthReport, getAdminMonthReport: mocks.getAdminMonthReport, getTeachers: mocks.getTeachers, getMyClasses: vi.fn(), createClass: vi.fn(), updateClass: vi.fn(), scheduleBookings: vi.fn(), editBooking: vi.fn(), cancelBooking: vi.fn() }));
vi.mock('../../src/lib/session', () => ({ bootstrapNativeSession: mocks.bootstrap, onNativeAuthStateChange: mocks.auth, getProfile: mocks.profile }));

describe('App schedule integration', () => {
  beforeEach(() => {
    mocks.getDay.mockResolvedValue({ date: '2026-11-02', slots: daySlots('2026-11-02'), bookings: [] });
    mocks.getMyMonthReport.mockResolvedValue({ month: '2026-11', teacherId: 'teacher', teacherName: 'Teacher', reservationCount: 0, cancelledCount: 0, totalDue: '0.00', rows: [] });
    mocks.getAdminMonthReport.mockResolvedValue({ month: '2026-11', teacherId: null, teachers: [], cashboxTotal: '0.00' });
    mocks.getTeachers.mockResolvedValue([]);
    mocks.bootstrap.mockResolvedValue({}); mocks.auth.mockReturnValue({ unsubscribe: vi.fn() });
    mocks.profile.mockReturnValue({ id: 'teacher', name: 'Teacher', role: 'teacher' });
  });
  test('loads the authoritative schedule after session bootstrap', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(mocks.getDay).toHaveBeenCalledTimes(1);
  });

  test('shows the teacher report destination and only calls the teacher report RPC', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Monthly report' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Monthly report' }));
    expect(await screen.findByRole('heading', { name: 'Monthly report' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.getMyMonthReport).toHaveBeenCalled());
    expect(mocks.getAdminMonthReport).not.toHaveBeenCalled();
  });

  test('shows the administrator destination only for admins and calls the admin report RPC', async () => {
    mocks.profile.mockReturnValue({ id: 'admin', name: 'Admin', role: 'admin' });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Administrator report' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Monthly report' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Administrator report' }));
    expect(await screen.findByRole('heading', { name: 'Administrator report' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.getAdminMonthReport).toHaveBeenCalled());
    expect(mocks.getMyMonthReport).not.toHaveBeenCalled();
  });
});
