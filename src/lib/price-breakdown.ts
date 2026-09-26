import type { PriceSegment } from './types';

export interface GroupedPriceSegment extends PriceSegment {
  count: number;
}

function sameTariff(left: PriceSegment, right: PriceSegment): boolean {
  return left.rule_id === right.rule_id
    && left.label === right.label
    && left.hourly_rate === right.hourly_rate;
}

function addSubtotals(left: string, right: string): string {
  const amounts = [Number(left), Number(right)];
  if (amounts.some((amount) => !Number.isFinite(amount))) return left;
  return amounts.reduce((total, amount) => total + amount, 0).toFixed(2);
}

export function groupPriceSegments(segments: PriceSegment[]): GroupedPriceSegment[] {
  const grouped: GroupedPriceSegment[] = [];

  for (const segment of segments) {
    const previous = grouped.at(-1);
    if (previous && sameTariff(previous, segment)) {
      previous.count += 1;
      previous.ends_at = segment.ends_at;
      previous.subtotal = addSubtotals(previous.subtotal, segment.subtotal);
      continue;
    }

    grouped.push({ ...segment, count: 1 });
  }

  return grouped;
}

export function formatAmount(value: string, currency = 'EUR'): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${currency} ${value}`;
  if (currency.toUpperCase() === 'EUR') return `€${amount.toFixed(2)}`;
  return `${currency} ${amount.toFixed(2)}`;
}
