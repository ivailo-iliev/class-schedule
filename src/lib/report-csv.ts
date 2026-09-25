import type { MonthReportRow } from './types';

const csvCell = (value: string | number | null | undefined): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const localDateTime = (value: string): string => value.replace('T', ' ').slice(0, 16);

export function reportRowsToCsv(rows: MonthReportRow[]): string {
  const header = [
    'Дата', 'Начало', 'Край', 'Продължителност (минути)', 'Зала', 'Учител', 'Дейност',
    'Статус', 'Запазена цена', 'Разбивка на цената', 'Дължима сума', 'Дата на отмяна',
  ];
  const lines = rows.map((row) => [
    row.bookingDate,
    localDateTime(row.startsAt),
    localDateTime(row.endsAt),
    row.durationMinutes,
    row.room === 'hall' ? 'Зала' : 'Стая',
    row.teacherName,
    row.activityTitle,
    row.cancelled ? 'Отменена' : 'Активна',
    row.calculatedAmount,
    JSON.stringify(row.priceBreakdown),
    row.effectiveAmountDue,
    row.cancelledAt ? localDateTime(row.cancelledAt) : '',
  ]);
  return [header, ...lines].map((line) => line.map(csvCell).join(',')).join('\r\n');
}
