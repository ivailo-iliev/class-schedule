import { describe, expect, test } from 'vitest';
import { formatAmount, groupPriceSegments } from '../../src/lib/price-breakdown';
import type { PriceSegment } from '../../src/lib/types';

function segment(overrides: Partial<PriceSegment> = {}): PriceSegment {
  return {
    starts_at: '2026-11-05T09:00:00',
    ends_at: '2026-11-05T09:30:00',
    rule_id: 'weekday-rule',
    label: 'Стандартна тарифа делник 08:30–17:00',
    hourly_rate: '10.00',
    subtotal: '5.00',
    ...overrides,
  };
}

describe('price breakdown presentation', () => {
  test('groups consecutive segments from the same tariff and totals their subtotals', () => {
    const grouped = groupPriceSegments([
      segment(),
      segment({ starts_at: '2026-11-05T09:30:00', ends_at: '2026-11-05T10:00:00' }),
      segment({
        starts_at: '2026-11-05T10:00:00',
        ends_at: '2026-11-05T10:30:00',
        rule_id: 'evening-rule',
        label: 'Стандартна тарифа вечер',
        hourly_rate: '20.00',
        subtotal: '10.00',
      }),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      label: 'Стандартна тарифа делник 08:30–17:00',
      count: 2,
      subtotal: '10.00',
      starts_at: '2026-11-05T09:00:00',
      ends_at: '2026-11-05T10:00:00',
    });
    expect(grouped[1]).toMatchObject({ label: 'Стандартна тарифа вечер', count: 1, subtotal: '10.00' });
  });

  test('formats euro amounts with the euro sign', () => {
    expect(formatAmount('5.00', 'EUR')).toBe('€5.00');
    expect(formatAmount('5.00', 'BGN')).toBe('BGN 5.00');
  });
});
