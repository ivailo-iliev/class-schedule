import { useEffect, useMemo, useState } from 'react';
import { getAdminMonthReport, getMyMonthReport, getTeachers } from '../lib/api';
import { formatAmount, groupPriceSegments } from '../lib/price-breakdown';
import { reportRowsToCsv } from '../lib/report-csv';
import type { AdminMonthReport, MonthReportRow, MyMonthReport, Profile } from '../lib/types';
import Icon from './Icon';

interface MonthlyReportProps { profile: Profile; }
type ReportData = MyMonthReport | AdminMonthReport;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function localDateTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

function timeRangeLabel(row: MonthReportRow): string {
  return `${localDateTime(row.startsAt).slice(11)}–${localDateTime(row.endsAt).slice(11)}`;
}

function weekdayLabel(date: string): string {
  return new Intl.DateTimeFormat('bg-BG', { weekday: 'long' }).format(new Date(`${date}T12:00:00Z`));
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
  anchor.download = `mesecen-otchet-${month}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function SummaryCards({ reservationCount, cancelledCount, totalDue, currency = 'EUR' }: {
  reservationCount: number; cancelledCount: number; totalDue: string; currency?: string;
}) {
  return (
    <div className="report-summary" aria-label="Обобщение на отчета">
      <div className="report-summary__card"><span>Резервации</span><strong>{reservationCount}</strong></div>
      <div className="report-summary__card"><span>Отменени</span><strong>{cancelledCount}</strong></div>
      <div className="report-summary__card"><span>Дължима сума</span><strong>{formatAmount(totalDue, currency)}</strong></div>
    </div>
  );
}

function RowTable({ rows }: { rows: MonthReportRow[] }) {
  if (rows.length === 0) return <p className="report-empty">Няма резервации за този месец.</p>;
  return (
    <div className="report-table-wrap">
      <table className="report-table">
        <caption className="sr-only">Подробности за разрешените резервации</caption>
        <thead>
          <tr>
            <th scope="col">Дата</th><th scope="col">Час</th>
            <th scope="col">Дейност</th><th scope="col">Зала</th><th scope="col">Статус</th>
            <th scope="col">Цена</th><th scope="col">За плащане</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.cancelled ? 'report-table__cancelled' : undefined}>
              <td>
                <span className="report-table__stacked">{row.bookingDate}</span>
                <span className="report-table__secondary">{weekdayLabel(row.bookingDate)}</span>
              </td>
              <td aria-label={`${timeRangeLabel(row)} (${row.durationMinutes} мин.)`}>
                <span className="report-table__stacked">{timeRangeLabel(row)}</span>
                <span className="report-table__secondary">{row.durationMinutes} мин.</span>
              </td>
              <td>
                <strong>{row.activityTitle}</strong>
                {row.priceBreakdown.length > 0 && (
                  <div className="report-breakdown">
                    <ul>
                      {groupPriceSegments(row.priceBreakdown).map((segment, index) => (
                        <li key={`${row.id}-${segment.rule_id ?? segment.label}-${segment.starts_at}-${index}`}>
                          {segment.count > 1 ? `${segment.count}x ` : ''}{segment.label}: {formatAmount(segment.subtotal, row.currency)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </td>
              <td>{roomLabel(row.room)}</td>
              <td>{row.cancelled ? 'Отменена' : 'Активна'}</td>
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
        if (active) setError('Отчетът не може да бъде зареден. Опитайте отново.');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [isAdmin, month, teacherId]); // teacherOptions intentionally only affects the first admin load.

  const rows = useMemo(() => reportRows(report), [report]);
  const reportMonth = report?.month ?? month;
  const adminReport = isAdmin && report && 'teachers' in report ? report : null;
  const teacherReport = !isAdmin && report && 'rows' in report ? report : null;

  return (
    <main className="report-shell">
      <div className="report-toolbar">
        <div className="report-actions">
          <input id="report-month" type="month" aria-label="Избор на месец" value={month} onChange={(event) => setMonth(event.target.value)} />
          {isAdmin && (
            <select id="report-teacher" aria-label="Учител" value={teacherId ?? ''} onChange={(event) => setTeacherId(event.target.value || null)}>
                <option value="">Всички учители</option>
                {teacherOptions.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
            </select>
          )}
        </div>
        {!loading && !error && report && (
          <div className="report-toolbar__buttons">
            <button type="button" className="icon-button" onClick={() => window.print()} aria-label="Отпечатай отчета" title="Отпечатай отчета"><Icon name="printer" /></button>
            <button type="button" className="icon-button icon-button--primary" onClick={() => downloadCsv(rows, reportMonth)} aria-label="Експортирай видимите редове като CSV" title="Експортирай CSV"><Icon name="download" /></button>
          </div>
        )}
      </div>

      {error && <div className="report-message report-message--error" role="alert">{error}</div>}
      {loading && <p className="report-message" role="status">Отчетът се зарежда…</p>}
      {!loading && !error && report && (
        <section className="report-print-area" aria-label="Отчет за печат">
          {teacherReport && <SummaryCards reservationCount={teacherReport.reservationCount} cancelledCount={teacherReport.cancelledCount} totalDue={teacherReport.totalDue} />}
          {adminReport && (
            <>
              <div className="report-cashbox"><span>Обща сума в касата</span><strong>{formatAmount(adminReport.cashboxTotal)}</strong></div>
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


    </main>
  );
}
