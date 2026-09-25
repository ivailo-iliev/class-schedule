import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MonthlyReport from '../../src/components/MonthlyReport';
import type { AdminMonthReport, MyMonthReport, MonthReportRow, Profile } from '../../src/lib/types';

const api = vi.hoisted(() => ({
  getMyMonthReport: vi.fn(),
  getAdminMonthReport: vi.fn(),
  getTeachers: vi.fn(),
}));
vi.mock('../../src/lib/api', () => api);

const row = (id: string, teacherId: string, teacherName: string, amount: string, cancelled = false): MonthReportRow => ({
  id, teacherId, teacherName, classId: `class-${id}`, activityTitle: `Activity ${id}`, bookingDate: '2026-11-05',
  startsAt: '2026-11-05T09:00:00', endsAt: '2026-11-05T10:30:00', durationMinutes: 90, room: 'hall', currency: 'EUR',
  calculatedAmount: amount, priceBreakdown: cancelled ? [] : [{ starts_at: '09:00', ends_at: '10:00', rule_id: 'rule-1', label: 'weekday', hourly_rate: amount, subtotal: amount }], cancelledAt: cancelled ? '2026-11-04T12:00:00' : null,
  cancelled, effectiveAmountDue: cancelled ? '0.00' : amount,
});

const teacherReport: MyMonthReport = {
  month: '2026-11', teacherId: 'teacher-a', teacherName: 'Teacher A', reservationCount: 2,
  cancelledCount: 1, totalDue: '10.00', rows: [row('a-active', 'teacher-a', 'Teacher A', '10.00'), row('a-cancelled', 'teacher-a', 'Teacher A', '20.00', true)],
};
const adminReport: AdminMonthReport = {
  month: '2026-11', teacherId: null, cashboxTotal: '20.00', teachers: [
    { teacherId: 'teacher-a', teacherName: 'Teacher A', reservationCount: 2, cancelledCount: 1, totalDue: '10.00', rows: teacherReport.rows },
    { teacherId: 'teacher-b', teacherName: 'Teacher B', reservationCount: 1, cancelledCount: 0, totalDue: '10.00', rows: [row('b-active', 'teacher-b', 'Teacher B', '10.00')] },
  ],
};

function profile(role: Profile['role']): Profile { return { id: role === 'admin' ? 'admin' : 'teacher-a', name: role === 'admin' ? 'Admin' : 'Teacher A', role }; }

describe('MonthlyReport', () => {
  beforeEach(() => {
    api.getMyMonthReport.mockResolvedValue(teacherReport);
    api.getAdminMonthReport.mockImplementation(async (_month: string, filter: string | null) => filter
      ? { ...adminReport, teacherId: filter, teachers: adminReport.teachers.filter((teacher) => teacher.teacherId === filter) }
      : adminReport);
    api.getTeachers.mockResolvedValue([
      profile('teacher'), { id: 'teacher-b', name: 'Teacher B', role: 'teacher' },
    ]);
  });

  test('teacher loads only personal report rows, cancelled totals, and print/export controls', async () => {
    render(<MonthlyReport profile={profile('teacher')} />);
    expect(await screen.findByRole('heading', { name: 'Monthly report' })).toBeInTheDocument();
    expect(api.getMyMonthReport).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/));
    expect(screen.getByText('Activity a-active')).toBeInTheDocument();
    expect(screen.getByText('Price breakdown')).toBeInTheDocument();
    expect(screen.getByText('Activity a-cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Teacher B')).not.toBeInTheDocument();
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    expect(screen.getAllByText('€10.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Export visible rows as CSV' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Printable monthly report' })).toHaveClass('report-print-area');
  });

  test('admin fetches all teachers, filters server-returned rows, and exposes combined total', async () => {
    render(<MonthlyReport profile={profile('admin')} />);
    expect(await screen.findByRole('heading', { name: 'Administrator report' })).toBeInTheDocument();
    expect(api.getAdminMonthReport).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/), null);
    expect(screen.getByRole('heading', { name: 'Teacher A' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Teacher B' })).toBeInTheDocument();
    expect(screen.getAllByText('€20.00').length).toBeGreaterThan(0);
    const filter = screen.getByRole('combobox', { name: 'Filter by teacher' });
    fireEvent.change(filter, { target: { value: 'teacher-b' } });
    await waitFor(() => expect(api.getAdminMonthReport).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/), 'teacher-b'));
    expect(screen.getByText('Activity b-active')).toBeInTheDocument();
    expect(screen.queryByText('Activity a-active')).not.toBeInTheDocument();
  });
});
