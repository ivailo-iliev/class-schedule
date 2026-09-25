import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getDay } from '../lib/api';
import { localDateOf, minutesOf } from '../lib/calendar';
import type { Booking, DaySchedule, Room } from '../lib/types';
import Icon from './Icon';

const ROOMS: readonly { id: Room; label: string }[] = [{ id: 'hall', label: 'Зала' }, { id: 'room', label: 'Стая' }];
type SlotSelection = { date: string; startsAt: string; hour?: number; room: Room };
type LoadSchedule = (date: string) => Promise<DaySchedule>;
export interface ScheduleProps { initialDate?: string; loadSchedule?: LoadSchedule; onSelectSlot?: (selection: SlotSelection) => void; onSelectBooking?: (booking: Booking) => void; offline?: boolean; }
export interface ScheduleHandle { refresh: () => Promise<DaySchedule | undefined>; }

function today(): string { return new Date().toISOString().slice(0, 10); }
function shiftDate(date: string, days: number): string { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function displayDate(date: string): string { return new Intl.DateTimeFormat('bg-BG', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); }
function timeLabel(local: string): string { return local.slice(11, 16); }
function classHue(id: string): number { let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return (hash % 12) * 30; }

const Schedule = forwardRef<ScheduleHandle, ScheduleProps>(function Schedule({ initialDate = today(), loadSchedule = getDay, onSelectSlot, onSelectBooking, offline = false }, ref) {
  const [date, setDate] = useState(initialDate);
  const [schedule, setSchedule] = useState<DaySchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [availabilityFresh, setAvailabilityFresh] = useState(false);
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
  const selectDate = (next: string) => { if (next && next !== date) { dateRef.current = next; setDate(next); } };
  const slots = schedule?.slots ?? [];
  const bookingAt = (room: Room, startsAt: string) => schedule?.bookings.find((booking) => booking.room === room && booking.startsAt <= startsAt && booking.endsAt > startsAt);
  const bookingStarts = (booking: Booking, startsAt: string) => booking.startsAt === startsAt;
  const spanFor = (booking: Booking) => Math.max(1, (minutesOf(booking.endsAt) - minutesOf(booking.startsAt)) / 30);
  const canBook = availabilityFresh && !loading && !error && !offline;
  return <main className="schedule-shell" aria-label="График">
    <p className="visually-hidden">Свързано</p>
    <header className="schedule-date-bar"><div className="date-controls" aria-label="Управление на датата в графика">
      <button type="button" onClick={() => selectDate(shiftDate(date, -1))} aria-label="Предишен ден" title="Предишен ден"><Icon name="chevronLeft" /></button>
      <label><span className="visually-hidden">Дата в графика</span><input type="date" value={date} onChange={(event) => selectDate(event.target.value)} /></label>
      <button type="button" onClick={() => selectDate(shiftDate(date, 1))} aria-label="Следващ ден" title="Следващ ден"><Icon name="chevronRight" /></button>
      <button type="button" onClick={() => void load(date).catch(() => undefined)} aria-label="Обнови графика" title="Обнови графика"><Icon name="refresh" /></button>
    </div><p className="selected-date">{displayDate(date)}</p></header>
    {Boolean(error) && <p className="schedule-message schedule-message--inline" role="alert"><strong>Графикът може да не е актуален.</strong> Свободните часове ще се показват само за преглед, докато графикът не бъде обновен.</p>}
    {loading && !schedule && <p className="schedule-loading" role="status">Графикът се зарежда…</p>}
    {schedule && <section className="schedule-grid" role="grid" aria-label={`График за ${displayDate(date)}`} style={{ gridTemplateRows: `44px repeat(${slots.length}, 3rem)` }}>
      <div className="schedule-grid__corner" aria-hidden="true">Час</div>{ROOMS.map((room) => <h2 className="schedule-grid__header" key={room.id}>{room.label}</h2>)}
      {slots.flatMap((slot, index) => [<div className="schedule-grid__hour" role="rowheader" key={`${slot.startsAt}:time`} style={{ gridRow: index + 2 }}>{timeLabel(slot.startsAt)}</div>, ...ROOMS.map((room) => {
        const booking = bookingAt(room.id, slot.startsAt); const label = `${room.label} в ${timeLabel(slot.startsAt)}`;
        if (booking && bookingStarts(booking, slot.startsAt)) return <button type="button" className={`booking${booking.canEdit ? ' booking--editable' : ''}`} key={`${slot.startsAt}:${room.id}:booking`} style={{ gridColumn: room.id === 'hall' ? 2 : 3, gridRow: `${index + 2} / span ${spanFor(booking)}`, zIndex: 1, '--class-hue': classHue(booking.classId) } as React.CSSProperties} aria-label={`Подробности за ${booking.className} — ${label}`} onClick={() => onSelectBooking?.(booking)}><strong>{booking.className}</strong><span>{booking.teacherName}</span></button>;
        return <div className="schedule-grid__cell" role="gridcell" key={`${slot.startsAt}:${room.id}`} style={{ gridColumn: room.id === 'hall' ? 2 : 3, gridRow: index + 2 }}>{!booking && (canBook ? <button type="button" className="empty-slot" aria-label={`Резервирай ${label}`} onClick={() => onSelectSlot?.({ date: localDateOf(slot.startsAt), startsAt: slot.startsAt, hour: Math.floor(minutesOf(slot.startsAt) / 60), room: room.id })}><Icon name="plus" /></button> : <div className="schedule-grid__unknown" aria-label={`${label} — недостъпно`}>Недостъпно</div>)}</div>;
      })])}
    </section>}
  </main>;
});
export default Schedule;
