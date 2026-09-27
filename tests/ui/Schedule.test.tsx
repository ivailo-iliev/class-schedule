import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { addCalendarDays, daySlots } from '../../src/lib/calendar';
import Schedule from '../../src/components/Schedule';
import type { DaySchedule, WeekSchedule } from '../../src/lib/types';

const scheduleStyles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
let scheduleStyleElement: HTMLStyleElement;

function weekFor(date: string): WeekSchedule {
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = addCalendarDays(date, -weekday);
  const days = Array.from({ length: 7 }, (_, index) => ({ date: addCalendarDays(start, index), slots: daySlots(addCalendarDays(start, index)), bookings: [] })) as WeekSchedule['days'];
  return { weekStart: start, weekEnd: addCalendarDays(start, 6), days };
}

describe('Schedule week cache and views', () => {
  beforeAll(() => {
    scheduleStyleElement = document.createElement('style');
    scheduleStyleElement.textContent = scheduleStyles;
    document.head.append(scheduleStyleElement);
  });

  afterAll(() => scheduleStyleElement.remove());

  beforeEach(() => localStorage.clear());

  test('uses one weekly request while moving through the loaded week and fetches once at its boundary', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-09-21" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Следващ ден' }));
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Предишен ден' }));
    expect(loader).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Предишен ден' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('2026-09-20');
  });

  test('selects a calendar date from the accessible picker without duplicate same-week loads', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-09-21" loadSchedule={loader} />);
    const picker = await screen.findByLabelText('Дата в графика');
    expect(picker).toHaveValue('2026-09-21');

    fireEvent.change(picker, { target: { value: '2026-09-24' } });
    await waitFor(() => expect(screen.getByText('чт, 24 сеп')).toBeInTheDocument());
    expect(loader).toHaveBeenCalledTimes(1);

    fireEvent.change(picker, { target: { value: '2026-09-28' } });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('2026-09-28');
    expect(picker).toHaveValue('2026-09-28');
  });

  test('shows a loading treatment rather than stale availability during a Day-mode week-boundary load', async () => {
    let resolveNext!: (week: WeekSchedule) => void;
    const next = new Promise<WeekSchedule>((resolve) => { resolveNext = resolve; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor('2026-09-27')).mockReturnValueOnce(next);
    render(<Schedule initialDate="2026-09-27" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });

    fireEvent.click(screen.getByRole('button', { name: 'Следващ ден' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('status')).toHaveTextContent('Графикът се зарежда…');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Резервирай/ })).toHaveLength(0);

    resolveNext(weekFor('2026-09-28'));
    expect(await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' })).toBeEnabled();
  });

  test('renders both rooms in day view and has a compact destination week action', async () => {
    const loader = vi.fn(async (date: string) => weekFor(date));
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Стая' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Покажи седмица' })).toBeInTheDocument();
    expect(screen.getByText('ср, 23 сеп')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    await screen.findByRole('button', { name: 'Покажи ден' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('heading')).toHaveLength(7);
    expect(screen.getByRole('grid').querySelectorAll('.empty-slot[data-room="hall"]').length).toBeGreaterThan(0);
    expect(screen.getByRole('grid').querySelectorAll('.empty-slot[data-room="room"]').length).toBe(0);
    expect(screen.getByRole('button', { name: 'Покажи ден' }).querySelector('svg.icon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Зала' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Стая' }));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('schedule-week-room')).toBe('room');
    expect(screen.getByRole('grid').querySelectorAll('.empty-slot[data-room="room"]').length).toBeGreaterThan(0);
    expect(screen.getByRole('grid').querySelectorAll('.empty-slot[data-room="hall"]').length).toBe(0);
  });

  test('moves a week at a time, updates the pending target range, and persists the view', async () => {
    let resolveNext!: (week: WeekSchedule) => void; let resolvePrevious!: (week: WeekSchedule) => void;
    const next = new Promise<WeekSchedule>((resolve) => { resolveNext = resolve; }); const previous = new Promise<WeekSchedule>((resolve) => { resolvePrevious = resolve; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor('2026-09-23')).mockReturnValueOnce(next).mockReturnValueOnce(previous);
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(loader).toHaveBeenLastCalledWith('2026-09-30');
    expect(screen.getByText('28 сеп – 4 окт')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 28 сеп – 4 окт');
    resolveNext(weekFor('2026-09-30')); await screen.findByRole('button', { name: 'Резервирай Зала на пн, 28 сеп в 08:30' });
    fireEvent.click(screen.getByRole('button', { name: 'Предишна седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
    expect(loader).toHaveBeenLastCalledWith('2026-09-23');
    expect(screen.getByText('21 сеп – 27 сеп')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп');
    resolvePrevious(weekFor('2026-09-23'));
    expect(localStorage.getItem('schedule-view-mode')).toBe('week');
  });

  test('ignores an obsolete adjacent-week response after returning to the loaded week', async () => {
    let resolveNext!: (week: WeekSchedule) => void;
    const next = new Promise<WeekSchedule>((resolve) => { resolveNext = resolve; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor('2026-09-23')).mockReturnValueOnce(next);
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп');

    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 28 сеп – 4 окт');
    fireEvent.click(screen.getByRole('button', { name: 'Предишна седмица' }));
    expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп');

    resolveNext(weekFor('2026-09-30'));
    await waitFor(() => expect(screen.getByRole('grid')).toHaveAttribute('aria-label', 'График за 21 сеп – 27 сеп'));
    expect(screen.getByRole('button', { name: 'Резервирай Зала на пн, 21 сеп в 08:30' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Резервирай Зала на пн, 28 сеп в 08:30' })).not.toBeInTheDocument();
  });

  test('restores accuracy-first pending state when returning to an in-flight adjacent week', async () => {
    let resolveNext!: (week: WeekSchedule) => void;
    const next = new Promise<WeekSchedule>((resolve) => { resolveNext = resolve; });
    const loader = vi.fn().mockResolvedValueOnce(weekFor('2026-09-23')).mockReturnValueOnce(next);
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));

    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByRole('button', { name: /^Резервирай/ })).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Предишна седмица' }));
    await screen.findByRole('button', { name: 'Резервирай Зала на пн, 21 сеп в 08:30' });
    fireEvent.click(screen.getByRole('button', { name: 'Следваща седмица' }));
    expect(loader).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Резервирай/ })).toHaveLength(0));

    resolveNext(weekFor('2026-09-30'));
    expect(await screen.findByRole('button', { name: 'Резервирай Зала на пн, 28 сеп в 08:30' })).toBeEnabled();
  });

  test('sends the actual weekday and selected room for week slots and rejects a cross-day drag', async () => {
    const onSelectSlot = vi.fn();
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} onSelectSlot={onSelectSlot} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const monday = await screen.findByRole('button', { name: /Резервирай Зала на пн, 21 сеп.*08:30/i });
    const tuesday = screen.getByRole('button', { name: /Резервирай Зала на вт, 22 сеп.*09:30/i });
    fireEvent.pointerDown(monday, { button: 0, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerEnter(tuesday, { pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerUp(tuesday, { pointerId: 7, pointerType: 'mouse' });
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-21', room: 'hall', startsAt: '2026-09-21T08:30:00' }));
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ endsAt: '2026-09-21T09:00:00' }));
  });

  test('selects a vertical range within one weekday while rejecting a drag into another weekday', async () => {
    const onSelectSlot = vi.fn();
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} onSelectSlot={onSelectSlot} />);
    await screen.findByRole('button', { name: 'Покажи седмица' });
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));

    const mondayStart = await screen.findByRole('button', { name: /Резервирай Зала на пн, 21 сеп.*08:30/i });
    const mondayEnd = screen.getByRole('button', { name: /Резервирай Зала на пн, 21 сеп.*09:30/i });
    const tuesday = screen.getByRole('button', { name: /Резервирай Зала на вт, 22 сеп.*09:30/i });
    fireEvent.pointerDown(mondayStart, { button: 0, pointerId: 11, pointerType: 'mouse' });
    fireEvent.pointerEnter(mondayEnd, { pointerId: 11, pointerType: 'mouse' });
    fireEvent.pointerUp(mondayEnd, { pointerId: 11, pointerType: 'mouse' });
    expect(onSelectSlot).toHaveBeenLastCalledWith(expect.objectContaining({
      date: '2026-09-21', room: 'hall', startsAt: '2026-09-21T08:30:00', endsAt: '2026-09-21T10:00:00',
    }));

    onSelectSlot.mockClear();
    fireEvent.pointerDown(mondayStart, { button: 0, pointerId: 12, pointerType: 'mouse' });
    fireEvent.pointerEnter(tuesday, { pointerId: 12, pointerType: 'mouse' });
    fireEvent.pointerUp(tuesday, { pointerId: 12, pointerType: 'mouse' });
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-09-21', room: 'hall', startsAt: '2026-09-21T08:30:00', endsAt: '2026-09-21T09:00:00',
    }));
  });

  test('uses each weekday slot timestamp for week booking, price, and selection', async () => {
    const onSelectSlot = vi.fn(); const onSelectBooking = vi.fn();
    const loader = async (date: string) => {
      const result = weekFor(date); const tuesday = result.days[1]!;
      tuesday.bookings = [{ id: 'tuesday-booking', classId: 'class', teacherId: 'teacher', className: 'Пилатес', teacherName: 'Ели', room: 'hall', startsAt: '2026-09-22T08:30:00', endsAt: '2026-09-22T10:00:00', hour: 8, cancelledAt: null, version: 1, canEdit: false }];
      tuesday.slotPrices = [{ startsAt: '2026-09-22T10:00:00', price: '7.00', currency: 'EUR' }]; return result;
    };
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} onSelectSlot={onSelectSlot} onSelectBooking={onSelectBooking} />);
    await screen.findByRole('button', { name: 'Покажи седмица' }); fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const booking = await screen.findByRole('button', { name: /Подробности за Пилатес.*вт, 22 сеп.*08:30/i });
    fireEvent.click(booking); expect(onSelectBooking).toHaveBeenCalledWith(expect.objectContaining({ id: 'tuesday-booking' }));
    const available = screen.getByRole('button', { name: /Резервирай Зала на вт, 22 сеп.*10:00/i });
    expect(available).toHaveTextContent('€7.00'); fireEvent.click(available);
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-22', room: 'hall', startsAt: '2026-09-22T10:00:00' }));
  });

  test('keeps price display and vertical multi-slot selection in day mode', async () => {
    const onSelectSlot = vi.fn();
    const loader = async (date: string) => {
      const result = weekFor(date); const day = result.days.find((item) => item.date === date)!;
      (day as DaySchedule).slotPrices = [{ startsAt: `${date}T08:30:00`, price: '5.00', currency: 'EUR' }]; return result;
    };
    render(<Schedule initialDate="2026-09-23" loadSchedule={loader} onSelectSlot={onSelectSlot} />);
    const start = await screen.findByRole('button', { name: 'Резервирай Зала в 08:30' });
    const end = screen.getByRole('button', { name: 'Резервирай Зала в 09:30' });
    expect(screen.getAllByText('€5.00')).toHaveLength(2);
    fireEvent.pointerDown(start, { button: 0, pointerId: 9, pointerType: 'mouse' });
    fireEvent.pointerEnter(end, { pointerId: 9, pointerType: 'mouse' });
    fireEvent.pointerUp(end, { pointerId: 9, pointerType: 'mouse' });
    expect(onSelectSlot).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-23', endsAt: '2026-09-23T10:00:00', room: 'hall' }));
  });

  test('keeps the sticky header outside the mobile-only horizontal grid scroller', async () => {
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} />);
    await screen.findByRole('grid');
    expect(screen.getByRole('banner')).toHaveClass('schedule-date-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const grid = await screen.findByRole('grid');
    expect(grid).toHaveClass('schedule-grid--week');
    const scroller = grid.querySelector('.schedule-grid-scroll')!;
    const stickyHeader = grid.querySelector('.schedule-grid__header-clip')!;
    expect(scroller).toBeInTheDocument();
    expect(stickyHeader).toBeInTheDocument();
    expect(scroller.contains(stickyHeader)).toBe(false);
    expect(stickyHeader.contains(scroller)).toBe(false);
    expect(grid.querySelector('.schedule-grid__corner')).toBeTruthy();
    const shell = grid.closest('.schedule-shell')!;
    expect(shell).toHaveStyle({ '--schedule-grid-sticky-top': 'calc(var(--app-bar-height) + var(--schedule-toolbar-height))' });
    expect(stickyHeader).toHaveStyle({ top: 'var(--schedule-grid-sticky-top)' });
    expect(grid.querySelector('.schedule-grid__header')).toBeTruthy();
  });

  test('keeps the schedule toolbar and grid sticky contract, with flexible desktop columns and mobile weekly scrolling', async () => {
    render(<Schedule initialDate="2026-09-23" loadSchedule={async (date) => weekFor(date)} />);
    await screen.findByRole('grid');
    const toolbar = screen.getByRole('banner');
    expect(toolbar).toHaveClass('schedule-date-bar');
    expect(toolbar).toHaveStyle({ position: 'sticky', top: 'var(--app-bar-height)', zIndex: '5' });

    fireEvent.click(screen.getByRole('button', { name: 'Покажи седмица' }));
    const grid = await screen.findByRole('grid');
    const stickyHeader = grid.querySelector('.schedule-grid__sticky-header') as HTMLElement;
    const body = grid.querySelector('.schedule-grid__body') as HTMLElement;
    const corner = grid.querySelector('.schedule-grid__corner') as HTMLElement;
    const timeColumn = grid.querySelector('.schedule-grid__hour') as HTMLElement;
    expect(stickyHeader).toHaveStyle({ gridTemplateColumns: '3.6rem repeat(7, minmax(0, 1fr))' });
    expect(body).toHaveStyle({ gridTemplateColumns: '3.6rem repeat(7, minmax(0, 1fr))' });
    expect(getComputedStyle(corner)).toMatchObject({ position: 'absolute', height: '44px', zIndex: '2' });
    expect(getComputedStyle(timeColumn)).toMatchObject({ position: 'sticky', left: '0px', zIndex: '1' });

    const topLevelRules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules));
    const gridScrollRule = topLevelRules.find((rule) => rule.type === CSSRule.STYLE_RULE && (rule as CSSStyleRule).selectorText === '.schedule-grid-scroll') as CSSStyleRule | undefined;
    const bodyRule = topLevelRules.find((rule) => rule.type === CSSRule.STYLE_RULE && (rule as CSSStyleRule).selectorText.includes('.schedule-grid__body')) as CSSStyleRule | undefined;
    const cornerRule = topLevelRules.find((rule) => rule.type === CSSRule.STYLE_RULE && (rule as CSSStyleRule).selectorText === '.schedule-grid__corner') as CSSStyleRule | undefined;
    expect(cornerRule?.style.width).toBe('3.6rem');
    const mobileRule = topLevelRules.find((rule) => rule.type === CSSRule.MEDIA_RULE && (rule as CSSMediaRule).conditionText === '(max-width: 800px)') as CSSMediaRule | undefined;
    expect(gridScrollRule?.style.overflow).toBe('visible');
    expect(bodyRule?.style.width).toBe('100%');
    expect(bodyRule?.style.minWidth).toBe('0px');
    const mobileStyles = Array.from(mobileRule?.cssRules ?? []).filter((rule): rule is CSSStyleRule => rule.type === CSSRule.STYLE_RULE);
    expect(mobileStyles.find((rule) => rule.selectorText === '.schedule-grid-scroll')?.style.overflowX).toBe('auto');
    expect(mobileStyles.find((rule) => rule.selectorText.includes('.schedule-grid--week .schedule-grid__body'))?.style.minWidth).toBe('calc(63.1rem)');
  });
});
