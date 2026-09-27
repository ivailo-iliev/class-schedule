export const CALENDAR_START_MINUTES = 8 * 60 + 30;
export const CALENDAR_END_MINUTES = 20 * 60;

function dateParts(date: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether a YYYY-MM-DD value names a real calendar day. */
export function isValidCalendarDate(date: string): boolean {
  const parts = dateParts(date);
  if (!parts) return false;
  const [year, month, day] = parts;
  const value = new Date(year, month - 1, day, 12);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day;
}

function validDate(date: string): void {
  if (!isValidCalendarDate(date)) throw new Error('invalid_date');
}

/** Today's date in the browser's local wall-clock calendar. */
export function todayCalendarDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Move a YYYY-MM-DD value by whole local calendar days. */
export function addCalendarDays(date: string, days: number): string {
  validDate(date);
  if (!Number.isInteger(days)) throw new Error('invalid_day_offset');
  const [year, month, day] = dateParts(date)!;
  const value = new Date(year, month - 1, day, 12);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** ISO weekday, where Monday is 1 and Sunday is 7. */
export function isoWeekday(date: string): number {
  validDate(date);
  const [year, month, day] = dateParts(date)!;
  const weekday = new Date(year, month - 1, day, 12).getDay();
  return weekday === 0 ? 7 : weekday;
}

/** Render a YYYY-MM-DD value as a local calendar date without instant conversion. */
export function formatCalendarDate(
  date: string,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' },
  locale = 'bg-BG',
): string {
  validDate(date);
  const [year, month, day] = dateParts(date)!;
  return new Intl.DateTimeFormat(locale, options).format(new Date(year, month - 1, day, 12));
}

export function localTime(date: string, minutes: number): string {
  validDate(date);
  return `${date}T${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}:00`;
}

export function minutesOf(localDateTime: string): number {
  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):00$/.exec(localDateTime);
  if (!match) throw new Error('invalid_local_time');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function daySlots(date: string) {
  validDate(date);
  return Array.from({ length: (CALENDAR_END_MINUTES - CALENDAR_START_MINUTES) / 30 }, (_, index) => ({
    startsAt: localTime(date, CALENDAR_START_MINUTES + index * 30),
  }));
}

export function localDateOf(localDateTime: string): string {
  return localDateTime.slice(0, 10);
}
