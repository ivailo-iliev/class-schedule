import { describe, expect, test } from 'vitest';
import {
  addCalendarDays,
  CALENDAR_END_MINUTES,
  CALENDAR_START_MINUTES,
  formatCalendarDate,
  isoWeekday,
  isValidCalendarDate,
  daySlots,
  localTime,
  minutesOf,
  todayCalendarDate,
} from '../../src/lib/calendar';

describe('local half-hour calendar', () => {
  test('uses 08:30 as the first displayed interval and 20:00 as its exclusive end', () => {
    const slots = daySlots('2026-03-29');
    expect(slots[0]).toEqual({ startsAt: '2026-03-29T08:30:00' });
    expect(slots.at(-1)).toEqual({ startsAt: '2026-03-29T19:30:00' });
    expect(CALENDAR_START_MINUTES).toBe(510);
    expect(CALENDAR_END_MINUTES).toBe(1200);
  });
  test('keeps local values unchanged across calendar dates', () => {
    expect(localTime('2026-03-29', 510)).toBe('2026-03-29T08:30:00');
    expect(minutesOf('2026-10-25T08:30:00')).toBe(510);
  });

  test('uses the browser-local wall clock for today rather than a UTC date', () => {
    expect(todayCalendarDate(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });

  test('validates and moves local calendar days across DST-boundary weeks', () => {
    expect(isValidCalendarDate('2026-02-29')).toBe(false);
    expect(isValidCalendarDate('2028-02-29')).toBe(true);
    expect(addCalendarDays('2026-03-29', 7)).toBe('2026-04-05');
    expect(addCalendarDays('2026-10-25', -7)).toBe('2026-10-18');
    expect(isoWeekday('2026-03-29')).toBe(7);
    expect(isoWeekday('2026-03-30')).toBe(1);
  });

  test('formats a YYYY-MM-DD as a local calendar date', () => {
    expect(formatCalendarDate('2026-03-29')).toContain('2026');
    expect(formatCalendarDate('2026-03-29', { weekday: 'long' })).toBe('неделя');
  });
});
