const TIME_ZONE = 'Europe/Sofia';
const HOUR_MS = 60 * 60 * 1000;

const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function partsFor(date: Date): Record<string, number> {
  return Object.fromEntries(localFormatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
}

function parseDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('invalid_date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error('invalid_date');
  }
  return [year, month, day];
}

function localFieldsAt(date: Date): Record<string, number> {
  return partsFor(date);
}

function offsetAt(utcMs: number): number {
  const fields = localFieldsAt(new Date(utcMs));
  const asUtc = Date.UTC(fields.year!, fields.month! - 1, fields.day!, fields.hour!, fields.minute!, fields.second!);
  return asUtc - utcMs;
}

/** Return the instant represented by a Sofia wall-clock hour, or null for DST gaps. */
export function localHourToInstant(date: string, hour: number): Date | null {
  const [year, month, day] = parseDate(date);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('invalid_hour');

  const wallMs = Date.UTC(year, month - 1, day, hour);
  let instantMs = wallMs - offsetAt(wallMs);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    instantMs = wallMs - offsetAt(instantMs);
  }

  const fields = localFieldsAt(new Date(instantMs));
  if (fields.year !== year || fields.month !== month || fields.day !== day || fields.hour !== hour ||
      fields.minute !== 0 || fields.second !== 0) return null;
  const previous = localFieldsAt(new Date(instantMs - HOUR_MS));
  const next = localFieldsAt(new Date(instantMs + HOUR_MS));
  if ((previous.year === year && previous.month === month && previous.day === day && previous.hour === hour &&
       previous.minute === 0 && previous.second === 0) ||
      (next.year === year && next.month === month && next.day === day && next.hour === hour &&
       next.minute === 0 && next.second === 0)) return null;
  return new Date(instantMs);
}

export function dayBounds(date: string): { start: Date; end: Date } {
  const [year, month, day] = parseDate(date);
  const start = localHourToInstant(date, 0);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDate = `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1).toString().padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
  const end = localHourToInstant(nextDate, 0);
  if (!start || !end) throw new Error('invalid_date');
  return { start, end };
}

export function localHourOf(instant: string | Date): number {
  return localFieldsAt(typeof instant === 'string' ? new Date(instant) : instant).hour!;
}

export function daySlots(date: string) {
  return Array.from({ length: 24 }, (_, hour) => {
    const instant = localHourToInstant(date, hour);
    return { hour, valid: instant !== null, startsAt: instant?.toISOString() ?? null };
  });
}

export const CALENDAR_TIME_ZONE = TIME_ZONE;
export const CALENDAR_HOUR_MS = HOUR_MS;
