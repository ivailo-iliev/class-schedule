import { useEffect, useMemo, useState } from 'react';
import { getAdminMonthReport, getMyMonthReport, getTeachers } from '../lib/api';
import { reportRowsToCsv } from '../lib/report-csv';
import type { AdminMonthReport, MonthReportRow, MyMonthReport, Profile } from '../lib/types';

interface MonthlyReportProps { profile: Profile; }
type ReportData = MyMonthReport | AdminMonthReport;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatAmount(value: string, currency = 'EUR'): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${currency} ${value}`;
  if (currency === 'EUR') return `€${amount.toFixed(2)}`;
  return `${currency} ${amount.toFixed(2)}`;
}

function localDateTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

function roomLabel(room: MonthReportRow['room']): string {
  return room === 'hall' ? 'Зала' : 'Стая';
}

function reportRows(data: ReportData | null): MonthReportRow[] {
  if (!data) return [];
  return 'rows' in data ? data.rows : data.teachers.flatMap((teacher) => teacher.rows);
}

function downloadCsv(rows: MonthReportRow[], month: string): void {
  const blob = new Blob([reportRowsToCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `monthly-report-${month}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function SummaryCards({ reservationCount, cancelledCount, totalDue, currency = 'EUR' }: {
  reservationCount: number; cancelledCount: number; totalDue: string; currency?: string;
}) {
  return (
    <div className="report-summary" aria-label="Report totals">
      <div className="report-summary__card"><span>Reservations</span><strong>{reservationCount}</strong></div>
      <div className="report-summary__card"><span>Cancelled</span><strong>{cancelledCount}</strong></div>
      <div className="report-summary__card"><span>Amount due</span><strong>{formatAmount(totalDue, currency)}</strong></div>
    </div>
  );
}

function RowTable({ rows }: { rows: MonthReportRow[] }) {
  if (rows.length === 0) return <p className="report-empty">No reservations in this month.</p>;
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <caption className="sr-only">Authorized reservation detail</caption>
        <thead>
          <tr>
            <th scope="col">Date</th><th scope="col">Time</th><th scope="col">Duration</th>
            <th scope="col">Room</th><th scope="col">Activity</th><th scope="col">Status</th>
            <th scope="col">Snapshot</th><th scope="col">Due</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.cancelled ? 'report-table__cancelled' : undefined}>
              <td>{row.bookingDate}</td>
              <td>{localDateTime(row.startsAt).slice(11)}–{localDateTime(row.endsAt).slice(11)}</td>
              <td>{row.durationMinutes} min</td>
              <td>{roomLabel(row.room)}</td>
              <td>
                <strong>{row.activityTitle}</strong>
                {row.priceBreakdown.length > 0 && (
                  <div className="report-breakdown">
                    <span>Price breakdown</span>
                    <ul>
                      {row.priceBreakdown.map((segment, index) => (
                        <li key={`${row.id}-${segment.rule_id ?? 'segment'}-${index}`}>
                          {segment.label}: {formatAmount(segment.subtotal, row.currency)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </td>
              <td>{row.cancelled ? 'Cancelled' : 'Active'}</td>
              <td>{formatAmount(row.calculatedAmount, row.currency)}</td>
              <td>{formatAmount(row.effectiveAmountDue, row.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MonthlyReport({ profile }: MonthlyReportProps) {
  const [month, setMonth] = useState(currentMonth);
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [teacherOptions, setTeacherOptions] = useState<Profile[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const isAdmin = profile.role === 'admin';

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        if (isAdmin) {
          const [nextReport, teachers] = await Promise.all([
            getAdminMonthReport(month, teacherId),
            teacherOptions.length === 0 ? getTeachers() : Promise.resolve(teacherOptions),
          ]);
          if (!active) return;
          setReport(nextReport);
          if (teachers.length > 0) setTeacherOptions(teachers);
          else setTeacherOptions(nextReport.teachers.map(({ teacherId: id, teacherName }) => ({ id, name: teacherName, role: 'teacher' })));
        } else {
          const nextReport = await getMyMonthReport(month);
          if (active) setReport(nextReport);
        }
      } catch {
        if (active) setError('Could not load this report. Try again.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [isAdmin, month, teacherId]); // teacherOptions intentionally only affects the first admin load.

  const rows = useMemo(() => reportRows(report), [report]);
  const title = isAdmin ? 'Administrator report' : 'Monthly report';
  const reportMonth = report?.month ?? month;
  const adminReport = isAdmin && report && 'teachers' in report ? report : null;
  const teacherReport = !isAdmin && report && 'rows' in report ? report : null;

  return (
    <main className="report-shell">
      <div className="report-header">
        <div>
          <p className="eyebrow">Usage reporting</p>
          <h1>{title}</h1>
          <p className="report-intro">Authorized reservation detail and effective amount due. Cancelled reservations contribute €0.00.</p>
        </div>
        <div className="report-actions">
          <label htmlFor="report-month">Report month</label>
          <input id="report-month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
          {isAdmin && (
            <label htmlFor="report-teacher">Filter by teacher
              <select id="report-teacher" value={teacherId ?? ''} onChange={(event) => setTeacherId(event.target.value || null)}>
                <option value="">All teachers</option>
                {teacherOptions.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      {error && <div className="report-message report-message--error" role="alert">{error}</div>}
      {loading && <p className="report-message" role="status">Loading report…</p>}
      {!loading && !error && report && (
        <section className="report-print-area" aria-label="Printable monthly report">
          {teacherReport && <SummaryCards reservationCount={teacherReport.reservationCount} cancelledCount={teacherReport.cancelledCount} totalDue={teacherReport.totalDue} />}
          {adminReport && (
            <>
              <div className="report-cashbox"><span>Combined cashbox total</span><strong>{formatAmount(adminReport.cashboxTotal)}</strong></div>
              {adminReport.teachers.map((teacher) => (
                <section className="report-teacher" key={teacher.teacherId} aria-labelledby={`teacher-${teacher.teacherId}`}>
                  <div className="report-teacher__header">
                    <h2 id={`teacher-${teacher.teacherId}`}>{teacher.teacherName}</h2>
                    <span>{formatAmount(teacher.totalDue)}</span>
                  </div>
                  <SummaryCards reservationCount={teacher.reservationCount} cancelledCount={teacher.cancelledCount} totalDue={teacher.totalDue} />
                  <RowTable rows={teacher.rows} />
                </section>
              ))}
            </>
          )}
          {teacherReport && <RowTable rows={teacherReport.rows} />}
        </section>
      )}

      {!loading && !error && report && (
        <div className="report-footer-actions">
          <button type="button" onClick={() => window.print()}>Print report</button>
          <button type="button" onClick={() => downloadCsv(rows, reportMonth)} aria-label="Export visible rows as CSV">Export CSV</button>
        </div>
      )}
    </main>
  );
}
