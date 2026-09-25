import { describe, expect, test } from 'vitest';
import { reportRowsToCsv } from '../../src/lib/report-csv';
import type { MonthReportRow } from '../../src/lib/types';

const rows: MonthReportRow[] = [{
  id: 'booking-1',
  teacherId: 'teacher-1',
  teacherName: 'Ana, Teacher',
  classId: 'class-1',
  activityTitle: 'Piano "Advanced"',
  bookingDate: '2026-11-05',
  startsAt: '2026-11-05T09:00:00',
  endsAt: '2026-11-05T10:30:00',
  durationMinutes: 90,
  room: 'hall',
  currency: 'EUR',
  calculatedAmount: '15.00',
  priceBreakdown: [{ starts_at: '09:00', ends_at: '10:00', rule_id: null, label: 'weekday', hourly_rate: '10.00', subtotal: '10.00' }],
  cancelledAt: null,
  cancelled: false,
  effectiveAmountDue: '15.00',
}];

describe('reportRowsToCsv', () => {
  test('serializes exactly the supplied authorized rows and preserves CSV quoting', () => {
    expect(reportRowsToCsv(rows)).toBe([
      'Дата,Начало,Край,Продължителност (минути),Зала,Учител,Дейност,Статус,Запазена цена,Разбивка на цената,Дължима сума,Дата на отмяна',
      '2026-11-05,2026-11-05 09:00,2026-11-05 10:30,90,Зала,"Ana, Teacher","Piano ""Advanced""",Активна,15.00,"[{""starts_at"":""09:00"",""ends_at"":""10:00"",""rule_id"":null,""label"":""weekday"",""hourly_rate"":""10.00"",""subtotal"":""10.00""}]",15.00,',
    ].join('\r\n'));
  });
});
