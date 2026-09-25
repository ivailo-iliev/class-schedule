import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import MonthlyReport from '../../src/components/MonthlyReport';
import { reportRowsToCsv } from '../../src/lib/report-csv';
import type { AdminMonthReport, MyMonthReport, MonthReportRow, Profile } from '../../src/lib/types';
const reportStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

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
  let reportStyleElement: HTMLStyleElement;

  beforeAll(() => {
    reportStyleElement = document.createElement('style');
    reportStyleElement.textContent = reportStyles;
    document.head.append(reportStyleElement);
  });

  afterAll(() => {
    reportStyleElement.remove();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getMyMonthReport.mockResolvedValue(teacherReport);
    api.getAdminMonthReport.mockImplementation(async (_month: string, filter: string | null) => filter
      ? { ...adminReport, teacherId: filter, teachers: adminReport.teachers.filter((teacher) => teacher.teacherId === filter) }
      : adminReport);
    api.getTeachers.mockResolvedValue([
      profile('teacher'), { id: 'teacher-b', name: 'Teacher B', role: 'teacher' },
    ]);
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
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

  test('exports exactly the filtered RPC rows, prints, and ignores browser-state rows', async () => {
    localStorage.setItem('report-rows', JSON.stringify([row('browser-only', 'teacher-b', 'Teacher B', '999.00')]));
    const createObjectURL = vi.fn(() => 'blob:monthly-report');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    render(<MonthlyReport profile={profile('admin')} />);
    expect(await screen.findByRole('heading', { name: 'Administrator report' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by teacher' }), { target: { value: 'teacher-a' } });
    await waitFor(() => expect(api.getAdminMonthReport).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-\d{2}$/), 'teacher-a'));

    const summary = screen.getByLabelText('Report totals');
    const amountDueCard = within(summary).getByText('Amount due').closest('div');
    expect(amountDueCard?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Amount due€10.00');
    expect(screen.getByText('Activity a-active')).toBeInTheDocument();
    expect(screen.getByText('Activity a-cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Activity b-active')).not.toBeInTheDocument();
    expect(screen.queryByText('Activity browser-only')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export visible rows as CSV' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const csv = await (createObjectURL.mock.calls[0][0] as Blob).text();
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(csv).toBe(reportRowsToCsv(teacherReport.rows));
    expect(csv).toContain('a-active');
    expect(csv).toContain('a-cancelled');
    expect(csv).toContain('Cancelled');
    expect(csv).toContain('20.00');
    expect(csv).toContain('0.00');
    expect(csv).not.toContain('b-active');
    expect(csv).not.toContain('browser-only');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:monthly-report');

    fireEvent.click(screen.getByRole('button', { name: 'Print report' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  test('keeps report controls and breakdowns correct across print and narrow-screen CSS', () => {
    const topLevelRules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
    const printRule = topLevelRules.find((rule) => rule.type === CSSRule.MEDIA_RULE && (rule as CSSMediaRule).conditionText === 'print') as CSSMediaRule | undefined;
    const narrowRule = topLevelRules.find((rule) => rule.type === CSSRule.MEDIA_RULE && (rule as CSSMediaRule).conditionText === '(max-width: 640px)') as CSSMediaRule | undefined;
    expect(printRule).toBeDefined();
    expect(narrowRule).toBeDefined();

    const printStyles = Array.from(printRule?.cssRules ?? []).filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    const hiddenInPrint = printStyles.find((rule) => rule.selectorText.includes('.report-footer-actions'));
    const breakdownInPrint = printStyles.find((rule) => rule.selectorText === '.report-breakdown');
    expect(hiddenInPrint?.style.display).toBe('none');
    expect(breakdownInPrint?.style.display).toBe('block');
    expect(breakdownInPrint?.style.breakInside).toBe('avoid');

    const narrowStyles = Array.from(narrowRule?.cssRules ?? []).filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    expect(narrowStyles.find((rule) => rule.selectorText === '.report-header')?.style.flexDirection).toBe('column');
    expect(narrowStyles.find((rule) => rule.selectorText === '.report-summary')?.style.gridTemplateColumns).toBe('1fr');
  });
});
