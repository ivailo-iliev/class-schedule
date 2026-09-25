import type { MonthReportRow } from './types';

const csvCell = (value: string | number | null | undefined): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const localDateTime = (value: string): string => value.replace('T', ' ').slice(0, 16);

export function reportRowsToCsv(rows: MonthReportRow[]): string {
  const header = [
    'Date', 'Start', 'End', 'Duration (minutes)', 'Room', 'Teacher', 'Activity',
    'Status', 'Snapshot amount', 'Price breakdown', 'Effective amount due', 'Cancellation',
  ];
  const lines = rows.map((row) => [
    row.bookingDate,
    localDateTime(row.startsAt),
    localDateTime(row.endsAt),
    row.durationMinutes,
    row.room === 'hall' ? 'Hall' : 'Room',
    row.teacherName,
    row.activityTitle,
    row.cancelled ? 'Cancelled' : 'Active',
    row.calculatedAmount,
    JSON.stringify(row.priceBreakdown),
    row.effectiveAmountDue,
    row.cancelledAt ? localDateTime(row.cancelledAt) : '',
  ]);
  return [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n');
}
