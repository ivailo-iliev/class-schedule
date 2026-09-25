export const CALENDAR_START_MINUTES = 8 * 60 + 30;
export const CALENDAR_END_MINUTES = 20 * 60;

function validDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) {
    throw new Error('invalid_date');
  }
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
