import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getWeek } from '../lib/api';
import { addCalendarDays, localDateOf, localTime, minutesOf, todayCalendarDate } from '../lib/calendar';
import type { Booking, DaySchedule, Room, SlotPrice, WeekSchedule } from '../lib/types';
import Icon from './Icon';

const ROOMS: readonly { id: Room; label: string }[] = [{ id: 'hall', label: 'Зала' }, { id: 'room', label: 'Стая' }];
const VIEW_MODE_STORAGE_KEY = 'schedule-view-mode';
const WEEK_ROOM_STORAGE_KEY = 'schedule-week-room';
type ViewMode = 'day' | 'week';
type SlotSelection = { date: string; startsAt: string; endsAt?: string; hour?: number; room: Room };
type DragSelection = { date: string; room: Room; startIndex: number; endIndex: number; pointerId: number };
type LoadSchedule = (date: string) => Promise<WeekSchedule>;
export interface ScheduleProps { initialDate?: string; loadSchedule?: LoadSchedule; onSelectSlot?: (selection: SlotSelection) => void; onSelectBooking?: (booking: Booking) => void; offline?: boolean; }
export interface ScheduleHandle { refresh: () => Promise<DaySchedule | undefined>; }

function today() { return todayCalendarDate(); }
function weekStartOf(date: string) { const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; return addCalendarDays(date, -weekday); }
const BG_WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const BG_MONTHS = ['ян', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
function dateLabel(date: string) { const month = Number(date.slice(5, 7)); const day = Number(date.slice(8, 10)); return `${day} ${BG_MONTHS[month - 1] ?? ''}`; }
function displayDay(date: string) { const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); return `${BG_WEEKDAYS[weekday]}, ${dateLabel(date)}`; }
function displayRange(start: string, end: string) { return `${dateLabel(start)} – ${dateLabel(end)}`; }
function timeLabel(local: string) { return local.slice(11, 16); }
function classHue(id: string) { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return (hash % 12) * 30; }
function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T { try { const value = window.localStorage.getItem(key); return allowed.includes(value as T) ? value as T : fallback; } catch { return fallback; } }
function formatSlotPrice(price: SlotPrice) { return price.currency === 'EUR' ? `€${price.price}` : `${price.price} ${price.currency}`; }

const Schedule = forwardRef<ScheduleHandle, ScheduleProps>(function Schedule({ initialDate = today(), loadSchedule = getWeek, onSelectSlot, onSelectBooking, offline = false }, ref) {
  const [date, setDate] = useState(initialDate);
  const [week, setWeek] = useState<WeekSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [availabilityFresh, setAvailabilityFresh] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStored(VIEW_MODE_STORAGE_KEY, ['day', 'week'], 'day'));
  const [weekRoom, setWeekRoom] = useState<Room>(() => readStored(WEEK_ROOM_STORAGE_KEY, ['hall', 'room'], 'hall'));
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const weekRef = useRef<WeekSchedule | null>(null); const dateRef = useRef(date); const requestId = useRef(0);
  const inFlight = useRef<{ weekStart: string; promise: Promise<WeekSchedule> } | null>(null); const skipClickRef = useRef(false); const skipFocusRef = useRef(false);
  weekRef.current = week; dateRef.current = date;
  const loadWeek = useCallback((requestedDate: string): Promise<WeekSchedule> => {
    const targetStart = weekStartOf(requestedDate);
    if (inFlight.current?.weekStart === targetStart) return inFlight.current.promise;
    const request = ++requestId.current;
    setLoading(true); setError(null); setAvailabilityFresh(false);
    const promise = loadSchedule(requestedDate).then((result) => {
      if (result.weekStart !== targetStart) throw new Error('invalid_week_response');
      if (request === requestId.current) { setWeek(result); weekRef.current = result; setAvailabilityFresh(true); }
      return result;
    }).catch((reason: unknown) => { if (request === requestId.current) { setError(reason); setAvailabilityFresh(false); } throw reason; }).finally(() => {
      if (request === requestId.current) setLoading(false);
      if (inFlight.current?.promise === promise) inFlight.current = null;
    });
    inFlight.current = { weekStart: targetStart, promise }; return promise;
  }, [loadSchedule]);
  const refresh = useCallback(async () => { const result = await loadWeek(dateRef.current); return result.days.find((day) => day.date === dateRef.current); }, [loadWeek]);
  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  useEffect(() => { const current = weekRef.current; if (!current || date < current.weekStart || date > current.weekEnd) void loadWeek(date).catch(() => undefined); }, [date, loadWeek]);
  useEffect(() => {
    const revalidate = () => { if (document.visibilityState === 'visible') void refresh().catch(() => undefined); };
    const onVisibility = () => { if (document.visibilityState === 'visible') { skipFocusRef.current = true; revalidate(); setTimeout(() => { skipFocusRef.current = false; }, 0); } };
    const onFocus = () => { if (!skipFocusRef.current) revalidate(); };
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  useEffect(() => { try { window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode); } catch { /* optional */ } }, [viewMode]);
  useEffect(() => { try { window.localStorage.setItem(WEEK_ROOM_STORAGE_KEY, weekRoom); } catch { /* optional */ } }, [weekRoom]);

  const selectedDay = week?.days.find((day) => day.date === date);
  const days = week ? (viewMode === 'day' ? (selectedDay ? [selectedDay] : []) : [...week.days]) : [];
  const rooms = viewMode === 'day' ? ROOMS : ROOMS.filter((room) => room.id === weekRoom);
  const slots = days[0]?.slots ?? []; const canBook = availabilityFresh && !loading && !error && !offline;
  const rangeIsFree = (day: DaySchedule, room: Room, first: number, last: number) => day.slots.slice(Math.min(first, last), Math.max(first, last) + 1).every((slot) => !day.bookings.some((booking) => booking.room === room && booking.startsAt <= slot.startsAt && booking.endsAt > slot.startsAt));
  const selectRange = (day: DaySchedule, room: Room, first: number, last: number, includeEndAt = true) => {
    const start = Math.min(first, last); const end = Math.max(first, last); const startSlot = day.slots[start]; const endSlot = day.slots[end];
    if (!startSlot || !endSlot || !rangeIsFree(day, room, start, end)) return;
    const selection: SlotSelection = { date: day.date, startsAt: startSlot.startsAt, hour: Math.floor(minutesOf(startSlot.startsAt) / 60), room };
    if (includeEndAt) selection.endsAt = day.slots[end + 1]?.startsAt ?? localTime(localDateOf(endSlot.startsAt), minutesOf(endSlot.startsAt) + 30);
    onSelectSlot?.(selection);
  };
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, day: DaySchedule, room: Room, index: number) => { if (!canBook || (event.button !== 0 && event.pointerType !== 'touch')) return; event.preventDefault(); skipClickRef.current = false; event.currentTarget.setPointerCapture?.(event.pointerId); setDragSelection({ date: day.date, room, startIndex: index, endIndex: index, pointerId: event.pointerId }); };
  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>, day: DaySchedule, room: Room, index: number) => setDragSelection((current) => !current || current.date !== day.date || current.room !== room || current.pointerId !== event.pointerId || !rangeIsFree(day, room, current.startIndex, index) ? current : { ...current, endIndex: index });
  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => { const current = dragSelection; if (!current || current.pointerId !== event.pointerId) return; event.preventDefault(); skipClickRef.current = true; const day = weekRef.current?.days.find((item) => item.date === current.date); if (day) selectRange(day, current.room, current.startIndex, current.endIndex); setDragSelection(null); };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => { if (!dragSelection || dragSelection.pointerId !== event.pointerId) return; const target = (typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : event.target) as Element | null; const slot = target?.closest<HTMLButtonElement>('.empty-slot'); if (!slot || slot.dataset.date !== dragSelection.date || slot.dataset.room !== dragSelection.room) return; const index = Number(slot.dataset.slotIndex); const day = weekRef.current?.days.find((item) => item.date === dragSelection.date); if (day && Number.isInteger(index)) updateDrag(event as ReactPointerEvent<HTMLButtonElement>, day, dragSelection.room, index); };
  const navStep = viewMode === 'day' ? 1 : 7; const navLabel = viewMode === 'day' ? displayDay(date) : week ? displayRange(week.weekStart, week.weekEnd) : displayRange(weekStartOf(date), addCalendarDays(weekStartOf(date), 6)); const toggleLabel = viewMode === 'day' ? 'Покажи седмица' : 'Покажи ден';

  return <main className="schedule-shell" aria-label="График"><p className="visually-hidden">Свързано</p>
    <header className="schedule-date-bar"><div className="date-controls" aria-label="Управление на графика">
      <button type="button" onClick={() => setDate(addCalendarDays(date, -navStep))} aria-label={viewMode === 'day' ? 'Предишен ден' : 'Предишна седмица'} title={viewMode === 'day' ? 'Предишен ден' : 'Предишна седмица'}><Icon name="chevronLeft" /></button><span className="date-picker__display" aria-live="polite">{navLabel}</span><button type="button" onClick={() => setDate(addCalendarDays(date, navStep))} aria-label={viewMode === 'day' ? 'Следващ ден' : 'Следваща седмица'} title={viewMode === 'day' ? 'Следващ ден' : 'Следваща седмица'}><Icon name="chevronRight" /></button><button type="button" onClick={() => setViewMode((value) => value === 'day' ? 'week' : 'day')} aria-label={toggleLabel} title={toggleLabel}><Icon name={viewMode === 'day' ? 'week' : 'day'} /></button>
    </div>{viewMode === 'week' && <fieldset className="room-controls" aria-label="Помещение за седмицата"><legend className="visually-hidden">Помещение за седмицата</legend>{ROOMS.map((room) => <button type="button" className={`room-toggle${weekRoom === room.id ? ' room-toggle--pressed' : ''}`} key={room.id} aria-pressed={weekRoom === room.id} onClick={() => setWeekRoom(room.id)}>{room.label}</button>)}</fieldset>}</header>
    {Boolean(error) && <p className="schedule-message schedule-message--inline" role="alert"><strong>Графикът може да не е актуален.</strong> Свободните часове ще се показват само за преглед, докато графикът не бъде обновен.</p>}{loading && !week && <p className="schedule-loading" role="status">Графикът се зарежда…</p>}
    {days.length > 0 && <div className="schedule-grid-scroll"><section className={`schedule-grid schedule-grid--${viewMode}`} role="grid" aria-label={`График за ${navLabel}`} style={{ gridTemplateColumns: `3.6rem repeat(${days.length * rooms.length}, minmax(0, 1fr))`, gridTemplateRows: `44px repeat(${slots.length}, 3rem)` }} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => setDragSelection(null)}><div className="schedule-grid__corner" aria-hidden="true">Час</div>{days.flatMap((day) => rooms.map((room) => <h2 className="schedule-grid__header" key={`${day.date}:${room.id}`}>{viewMode === 'week' ? displayDay(day.date) : room.label}</h2>))}
      {slots.flatMap((slot, index) => [<div className="schedule-grid__hour" role="rowheader" key={`${slot.startsAt}:time`} style={{ gridRow: index + 2 }}>{timeLabel(slot.startsAt)}</div>, ...days.flatMap((day, dayIndex) => rooms.map((room, roomIndex) => {
        const booking = day.bookings.find((item) => item.room === room.id && item.startsAt <= slot.startsAt && item.endsAt > slot.startsAt); const label = viewMode === 'week' ? `${room.label} на ${displayDay(day.date)} в ${timeLabel(slot.startsAt)}` : `${room.label} в ${timeLabel(slot.startsAt)}`; const column = 2 + dayIndex * rooms.length + roomIndex;
        if (booking?.startsAt === slot.startsAt) return <button type="button" className={`booking${booking.canEdit ? ' booking--editable' : ''}`} key={`${day.date}:${slot.startsAt}:${room.id}:booking`} style={{ gridColumn: column, gridRow: `${index + 2} / span ${Math.max(1, (minutesOf(booking.endsAt) - minutesOf(booking.startsAt)) / 30)}`, zIndex: 1, '--class-hue': classHue(booking.classId) } as React.CSSProperties} aria-label={`Подробности за ${booking.className} — ${label}`} onClick={() => onSelectBooking?.(booking)}><strong>{booking.className}</strong><span>{booking.teacherName}</span></button>;
        const selected = dragSelection?.date === day.date && dragSelection.room === room.id && index >= Math.min(dragSelection.startIndex, dragSelection.endIndex) && index <= Math.max(dragSelection.startIndex, dragSelection.endIndex); const price = day.slotPrices?.find((item) => item.startsAt === slot.startsAt); const priceId = `slot-price-${day.date}-${room.id}-${index}`;
        return <div className="schedule-grid__cell" role="gridcell" key={`${day.date}:${slot.startsAt}:${room.id}`} style={{ gridColumn: column, gridRow: index + 2 }}>{!booking && (canBook ? <button type="button" className={`empty-slot empty-slot--handle${selected ? ' empty-slot--selected' : ''}`} data-date={day.date} data-room={room.id} data-slot-index={index} aria-label={`Резервирай ${label}`} aria-describedby={price ? priceId : undefined} onPointerDown={(event) => beginDrag(event, day, room.id, index)} onPointerEnter={(event) => updateDrag(event, day, room.id, index)} onClick={() => { if (skipClickRef.current) { skipClickRef.current = false; return; } selectRange(day, room.id, index, index, false); }}><Icon name="plus" />{price && <span className="empty-slot__price" id={priceId}>{formatSlotPrice(price)}</span>}</button> : <div className="schedule-grid__unknown" aria-label={`${label} — недостъпно`}>Недостъпно</div>)}</div>;
      }))])}</section></div>}
  </main>;
});
export default Schedule;
