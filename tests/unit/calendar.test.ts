import { describe, expect, test } from 'vitest';
import { CALENDAR_END_MINUTES, CALENDAR_START_MINUTES, daySlots, localTime, minutesOf } from '../../src/lib/calendar';

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
});
