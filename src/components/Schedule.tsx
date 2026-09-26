import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getDay } from '../lib/api';
import { localDateOf, localTime, minutesOf } from '../lib/calendar';
import type { Booking, DaySchedule, Room, SlotPrice } from '../lib/types';
import Icon from './Icon';

const ROOMS: readonly { id: Room; label: string }[] = [{ id: 'hall', label: 'Зала' }, { id: 'room', label: 'Стая' }];
const ROOM_VISIBILITY_STORAGE_KEY = 'schedule-visible-rooms';
type SlotSelection = { date: string; startsAt: string; endsAt?: string; hour?: number; room: Room };
type DragSelection = { room: Room; startIndex: number; endIndex: number; pointerId: number };
type LoadSchedule = (date: string) => Promise<DaySchedule>;
export interface ScheduleProps { initialDate?: string; loadSchedule?: LoadSchedule; onSelectSlot?: (selection: SlotSelection) => void; onSelectBooking?: (booking: Booking) => void; offline?: boolean; }
export interface ScheduleHandle { refresh: () => Promise<DaySchedule | undefined>; }

function today(): string { return new Date().toISOString().slice(0, 10); }
function shiftDate(date: string, days: number): string { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function displayDate(date: string): string { return new Intl.DateTimeFormat('bg-BG', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); }
function timeLabel(local: string): string { return local.slice(11, 16); }
function classHue(id: string): number { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return (hash % 12) * 30; }
function readVisibleRooms(): Room[] {
  const defaults = ROOMS.map((room) => room.id);
  if (typeof window === 'undefined') return defaults;
  try {
    const stored = JSON.parse(window.localStorage.getItem(ROOM_VISIBILITY_STORAGE_KEY) ?? 'null') as unknown;
    if (!Array.isArray(stored)) return defaults;
    return defaults.filter((room) => stored.includes(room));
  } catch {
    return defaults;
  }
}
function formatSlotPrice(price: SlotPrice): string { return price.currency === 'EUR' ? `€${price.price}` : `${price.price} ${price.currency}`; }

const Schedule = forwardRef<ScheduleHandle, ScheduleProps>(function Schedule({ initialDate = today(), loadSchedule = getDay, onSelectSlot, onSelectBooking, offline = false }, ref) {
  const [date, setDate] = useState(initialDate);
  const [schedule, setSchedule] = useState<DaySchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [availabilityFresh, setAvailabilityFresh] = useState(false);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [visibleRooms, setVisibleRooms] = useState<Room[]>(readVisibleRooms);
  const skipClickRef = useRef(false);
  const requestId = useRef(0); const dateRef = useRef(date); const scheduleRef = useRef<DaySchedule | null>(null);
  dateRef.current = date; scheduleRef.current = schedule;
  const load = useCallback(async (nextDate: string): Promise<DaySchedule | undefined> => {
    const request = ++requestId.current; const preserve = scheduleRef.current?.date === nextDate;
    if (!preserve) { setSchedule(null); scheduleRef.current = null; }
    setLoading(true); setError(null); setAvailabilityFresh(false);
    try { const result = await loadSchedule(nextDate); if (request !== requestId.current) return undefined; setSchedule(result); scheduleRef.current = result; setAvailabilityFresh(true); return result; }
    catch (reason) { if (request === requestId.current) { setError(reason); setAvailabilityFresh(false); } throw reason; }
    finally { if (request === requestId.current) setLoading(false); }
  }, [loadSchedule]);
  useImperativeHandle(ref, () => ({ refresh: () => load(dateRef.current) }), [load]);
  useEffect(() => { void load(date).catch(() => undefined); }, [date, load]);
  useEffect(() => { const onVisibility = () => { if (document.visibilityState === 'visible') void load(dateRef.current).catch(() => undefined); }; document.addEventListener('visibilitychange', onVisibility); return () => document.removeEventListener('visibilitychange', onVisibility); }, [load]);
  useEffect(() => {
    try { window.localStorage.setItem(ROOM_VISIBILITY_STORAGE_KEY, JSON.stringify(visibleRooms)); } catch { /* local persistence is optional */ }
  }, [visibleRooms]);
  const selectDate = (next: string) => { if (next && next !== date) { dateRef.current = next; setDate(next); } };
  const slots = schedule?.slots ?? [];
  const slotPriceAt = (startsAt: string) => schedule?.slotPrices?.find((price) => price.startsAt === startsAt);
  const bookingAt = (room: Room, startsAt: string) => schedule?.bookings.find((booking) => booking.room === room && booking.startsAt <= startsAt && booking.endsAt > startsAt);
  const bookingStarts = (booking: Booking, startsAt: string) => booking.startsAt === startsAt;
  const spanFor = (booking: Booking) => Math.max(1, (minutesOf(booking.endsAt) - minutesOf(booking.startsAt)) / 30);
  const canBook = availabilityFresh && !loading && !error && !offline;
  const toggleRoom = (room: Room) => setVisibleRooms((current) => current.includes(room) ? current.filter((item) => item !== room) : [...current, room]);
  const visibleRoomDefinitions = ROOMS.filter((room) => visibleRooms.includes(room.id));
  const roomColumn = (room: Room): number => visibleRoomDefinitions.findIndex((item) => item.id === room) + 2;
  const rangeIsFree = (room: Room, startIndex: number, endIndex: number): boolean => {
    const first = Math.min(startIndex, endIndex);
    const last = Math.max(startIndex, endIndex);
    return slots.slice(first, last + 1).every((slot) => !bookingAt(room, slot.startsAt));
  };
  const selectRange = (room: Room, startIndex: number, endIndex: number, includeEndAt = true) => {
    const first = Math.min(startIndex, endIndex);
    const last = Math.max(startIndex, endIndex);
    const startSlot = slots[first];
    const endSlot = slots[last];
    if (!startSlot || !endSlot || !rangeIsFree(room, first, last)) return;
    const endsAt = slots[last + 1]?.startsAt ?? localTime(localDateOf(endSlot.startsAt), minutesOf(endSlot.startsAt) + 30);
    const selection: SlotSelection = {
      date: localDateOf(startSlot.startsAt),
      startsAt: startSlot.startsAt,
      hour: Math.floor(minutesOf(startSlot.startsAt) / 60),
      room,
    };
    if (includeEndAt) selection.endsAt = endsAt;
    onSelectSlot?.(selection);
  };
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, room: Room, index: number) => {
    if (!canBook || (event.button !== 0 && event.pointerType !== 'touch')) return;
    event.preventDefault();
    skipClickRef.current = false;
    setDragSelection({ room, startIndex: index, endIndex: index, pointerId: event.pointerId });
  };
  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>, room: Room, index: number) => {
    setDragSelection((current) => {
      if (!current || current.room !== room || current.pointerId !== event.pointerId || !rangeIsFree(room, current.startIndex, index)) return current;
      return { ...current, endIndex: index };
    });
  };
  const finishDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragSelection;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    skipClickRef.current = true;
    selectRange(current.room, current.startIndex, current.endIndex);
    setDragSelection(null);
  };
  const cancelDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragSelection?.pointerId === event.pointerId) setDragSelection(null);
  };
  return <main className="schedule-shell" aria-label="График">
    <p className="visually-hidden">Свързано</p>
    <header className="schedule-date-bar"><div className="date-controls" aria-label="Управление на датата в графика">
      <button type="button" onClick={() => selectDate(shiftDate(date, -1))} aria-label="Предишен ден" title="Предишен ден"><Icon name="chevronLeft" /></button>
      <label className="date-picker"><span className="visually-hidden">Дата в графика</span><span className="date-picker__display" aria-hidden="true">{displayDate(date)}</span><input type="date" aria-label="Дата в графика" value={date} onChange={(event) => selectDate(event.target.value)} /></label>
      <button type="button" onClick={() => selectDate(shiftDate(date, 1))} aria-label="Следващ ден" title="Следващ ден"><Icon name="chevronRight" /></button>
      <button type="button" onClick={() => void load(date).catch(() => undefined)} aria-label="Обнови графика" title="Обнови графика"><Icon name="refresh" /></button>
    </div><fieldset className="room-controls" aria-label="Показване на помещенията"><legend className="visually-hidden">Показване на помещенията</legend>{ROOMS.map((room) => <label className="room-toggle" key={room.id}><input type="checkbox" checked={visibleRooms.includes(room.id)} onChange={() => toggleRoom(room.id)} /><span>{room.label}</span></label>)}</fieldset></header>
    {Boolean(error) && <p className="schedule-message schedule-message--inline" role="alert"><strong>Графикът може да не е актуален.</strong> Свободните часове ще се показват само за преглед, докато графикът не бъде обновен.</p>}
    {loading && !schedule && <p className="schedule-loading" role="status">Графикът се зарежда…</p>}
    {schedule && <section className="schedule-grid" role="grid" aria-label={`График за ${displayDate(date)}`} style={{ gridTemplateColumns: `3.6rem repeat(${visibleRoomDefinitions.length}, minmax(0, 1fr))`, gridTemplateRows: `44px repeat(${slots.length}, 3rem)` }} onPointerUp={finishDrag} onPointerCancel={cancelDrag}>
      <div className="schedule-grid__corner" aria-hidden="true">Час</div>{visibleRoomDefinitions.map((room) => <h2 className="schedule-grid__header" key={room.id}>{room.label}</h2>)}
      {slots.flatMap((slot, index) => [<div className="schedule-grid__hour" role="rowheader" key={`${slot.startsAt}:time`} style={{ gridRow: index + 2 }}>{timeLabel(slot.startsAt)}</div>, ...visibleRoomDefinitions.map((room) => {
        const booking = bookingAt(room.id, slot.startsAt); const label = `${room.label} в ${timeLabel(slot.startsAt)}`;
        if (booking && bookingStarts(booking, slot.startsAt)) return <button type="button" className={`booking${booking.canEdit ? ' booking--editable' : ''}`} key={`${slot.startsAt}:${room.id}:booking`} style={{ gridColumn: roomColumn(room.id), gridRow: `${index + 2} / span ${spanFor(booking)}`, zIndex: 1, '--class-hue': classHue(booking.classId) } as React.CSSProperties} aria-label={`Подробности за ${booking.className} — ${label}`} onClick={() => onSelectBooking?.(booking)}><strong>{booking.className}</strong><span>{booking.teacherName}</span></button>;
        const selected = dragSelection?.room === room.id && index >= Math.min(dragSelection.startIndex, dragSelection.endIndex) && index <= Math.max(dragSelection.startIndex, dragSelection.endIndex);
        const price = slotPriceAt(slot.startsAt);
        const priceId = `slot-price-${room.id}-${slot.startsAt.replace(/[^0-9]/g, '')}`;
        return <div className="schedule-grid__cell" role="gridcell" key={`${slot.startsAt}:${room.id}`} style={{ gridColumn: roomColumn(room.id), gridRow: index + 2 }}>{!booking && (canBook ? <button
          type="button"
          className={`empty-slot${selected ? ' empty-slot--selected' : ''}`}
          aria-label={`Резервирай ${label}`}
          aria-describedby={price ? priceId : undefined}
          onPointerDown={(event) => beginDrag(event, room.id, index)}
          onPointerEnter={(event) => updateDrag(event, room.id, index)}
          onClick={() => {
            if (skipClickRef.current) {
              skipClickRef.current = false;
              return;
            }
            selectRange(room.id, index, index, false);
          }}
        ><Icon name="plus" />{price && <span className="empty-slot__price" id={priceId}>{formatSlotPrice(price)}</span>}</button> : <div className="schedule-grid__unknown" aria-label={`${label} — недостъпно`}>Недостъпно</div>)}</div>;
      })])}
    </section>}
  </main>;
});
export default Schedule;
