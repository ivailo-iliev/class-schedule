import { describe, expect, test } from 'vitest';
import { daySlots, dayBounds, localHourToInstant } from '../../src/lib/calendar';

describe('Sofia calendar conversion', () => {
  test('preserves wall-clock hour across daylight-saving changes', () => {
    expect(localHourToInstant('2026-03-28', 10)?.toISOString()).toBe('2026-03-28T08:00:00.000Z');
    expect(localHourToInstant('2026-03-29', 10)?.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  test('marks nonexistent spring and ambiguous autumn hours invalid', () => {
    expect(localHourToInstant('2026-03-29', 3)).toBeNull();
    expect(localHourToInstant('2026-10-25', 3)).toBeNull();
    expect(daySlots('2026-03-29')[3]).toMatchObject({ hour: 3, valid: false, startsAt: null });
  });

  test('returns a half-open local-day range', () => {
    const bounds = dayBounds('2026-03-29');
    expect(bounds.start.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-03-29T21:00:00.000Z');
  });
});
