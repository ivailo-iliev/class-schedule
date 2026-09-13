import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { getDay } from '../lib/api';
import type { Booking, DaySchedule, Room } from '../lib/types';

const FOREGROUND_REFRESH_MS = 30_000;
const ROOMS: readonly { id: Room; label: string }[] = [
  { id: 'room_1', label: 'Room 1' },
  { id: 'room_2', label: 'Room 2' },
];

type SlotSelection = { date: string; hour: number; room: Room };
type LoadSchedule = (date: string) => Promise<DaySchedule>;

export interface ScheduleProps {
  initialDate?: string;
  loadSchedule?: LoadSchedule;
  onSelectSlot?: (selection: SlotSelection) => void;
  onSelectBooking?: (booking: Booking) => void;
  offline?: boolean;
}

export interface ScheduleHandle {
  refresh: () => Promise<DaySchedule | undefined>;
}

function todayInSofia(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function displayDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Sofia', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(parsed);
}

function hourLabel(hour: number): string {
  return `${hour.toString().padStart(2, '0')}:00`;
}

function bookingMap(schedule: DaySchedule): Map<string, Booking> {
  const bookings = new Map<string, Booking>();
  for (const booking of schedule.bookings) {
    const key = `${booking.room}:${booking.hour}`;
    const existing = bookings.get(key);
    // A cancelled historical instance may share a slot with a later booking.
    // Prefer the current booking while retaining cancelled-only history.
    if (!existing || (existing.cancelledAt !== null && booking.cancelledAt === null)) {
      bookings.set(key, booking);
    }
  }
  return bookings;
}

const Schedule = forwardRef<ScheduleHandle, ScheduleProps>(function Schedule({
  initialDate = todayInSofia(),
  loadSchedule = getDay,
  onSelectSlot,
  onSelectBooking,
  offline = false,
}: ScheduleProps, ref) {
  const [date, setDate] = useState(initialDate);
  const [schedule, setSchedule] = useState<DaySchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const requestId = useRef(0);
  const dateRef = useRef(date);
  const scheduleRef = useRef<DaySchedule | null>(null);
  const lastLoadedAt = useRef(0);

  dateRef.current = date;
  scheduleRef.current = schedule;

  const load = useCallback(async (nextDate: string): Promise<DaySchedule | undefined> => {
    const request = ++requestId.current;
    const hasCurrentSchedule = scheduleRef.current?.date === nextDate;
    if (!hasCurrentSchedule) {
      setSchedule(null);
      scheduleRef.current = null;
      setStale(false);
    }
    setLoading(true);
    setError(null);
    try {
      const result = await loadSchedule(nextDate);
      if (request !== requestId.current) return undefined;
      setSchedule(result);
      scheduleRef.current = result;
      setStale(false);
      lastLoadedAt.current = Date.now();
      return result;
    } catch (reason) {
      if (request !== requestId.current) return;
      setError(reason);
      setStale(hasCurrentSchedule);
      throw reason;
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [loadSchedule]);

  useImperativeHandle(ref, () => ({
    refresh: () => load(dateRef.current),
  }), [load]);

  useEffect(() => {
    void load(date).catch(() => undefined);
  }, [date, load]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadedAt.current < FOREGROUND_REFRESH_MS) return;
      void load(dateRef.current).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [load]);

  const selectDate = (nextDate: string) => {
    if (!nextDate || nextDate === date) return;
    dateRef.current = nextDate;
    setDate(nextDate);
  };

  const currentSlots = new Map((schedule?.slots ?? []).map((slot) => [slot.hour, slot]));
  const bookings = schedule ? bookingMap(schedule) : new Map<string, Booking>();
  const showGrid = schedule !== null;

  return (
    <main className="schedule-shell" aria-labelledby="schedule-title">
      <p className="visually-hidden">Connected</p>
      <header className="schedule-date-bar">
        <div>
          <h1 id="schedule-title">Daily schedule</h1>
          <p className="timezone-label">Europe/Sofia</p>
        </div>
        <div className="date-controls" aria-label="Schedule date controls">
          <button type="button" onClick={() => selectDate(shiftDate(date, -1))} aria-label="Previous day">
            ‹
          </button>
          <label>
            <span className="visually-hidden">Schedule date</span>
            <input type="date" value={date} onChange={(event) => selectDate(event.target.value)} />
          </label>
          <button type="button" onClick={() => selectDate(shiftDate(date, 1))} aria-label="Next day">
            ›
          </button>
          <button type="button" onClick={() => void load(date).catch(() => undefined)} aria-label="Refresh schedule">
            Refresh
          </button>
        </div>
        <p className="selected-date">{displayDate(date)}</p>
      </header>

      {error !== null && !showGrid && (
        <section className="schedule-message" role="alert">
          <strong>{offline ? 'You are offline.' : 'Unable to load schedule'}</strong>
          <p>{offline
            ? 'Reconnect to load the latest availability. Booking is disabled while offline.'
            : 'Availability is hidden until the connection is restored.'}</p>
          <button type="button" onClick={() => void load(date).catch(() => undefined)}>Try again</button>
        </section>
      )}
      {offline && showGrid && (
        <p className="schedule-message schedule-message--inline" role="alert">
          <strong>You are offline.</strong> Availability is hidden and booking is disabled until the connection is restored.
        </p>
      )}
      {error !== null && showGrid && (
        <p className="schedule-message schedule-message--inline" role="alert">
          <strong>Schedule may be out of date.</strong> Availability is read-only until refreshed.
        </p>
      )}
      {loading && !showGrid && <p className="schedule-loading" role="status">Loading schedule…</p>}

      {showGrid && (
        <section className={`schedule-grid${stale ? ' schedule-grid--stale' : ''}`} role="grid" aria-label={`Schedule for ${displayDate(date)}`}>
          <div className="schedule-grid__corner" aria-hidden="true">Hour</div>
          {ROOMS.map((room) => (
            <h2 className="schedule-grid__header" key={room.id}>{room.label}</h2>
          ))}
          {Array.from({ length: 24 }, (_, hour) => {
            const slot = currentSlots.get(hour);
            const valid = slot?.valid === true;
            return (
              <div className="schedule-grid__row" role="row" key={hour}>
                <div className="schedule-grid__hour" role="rowheader">{hourLabel(hour)}</div>
                {ROOMS.map((room) => {
                  const booking = bookings.get(`${room.id}:${hour}`);
                  const cellLabel = `${room.label} at ${hourLabel(hour)}`;
                  return (
                    <div className="schedule-grid__cell" role="gridcell" key={room.id}>
                      {!valid ? (
                        <button type="button" disabled aria-label={`${hourLabel(hour)} unavailable on this date`}>
                          Unavailable
                        </button>
                      ) : booking ? (
                        <button
                          type="button"
                          className={`booking${booking.canEdit ? ' booking--editable' : ''}`}
                          aria-label={`View details for ${booking.className} in ${cellLabel}`}
                          onClick={() => onSelectBooking?.(booking)}
                        >
                          <strong>{booking.className}</strong>
                          <span>{booking.teacherName}</span>
                        </button>
                      ) : stale || offline ? (
                        <div className="schedule-grid__unknown" aria-label={`${cellLabel} unavailable ${offline ? 'offline' : 'while schedule is stale'}`}>
                          {offline ? 'Unavailable offline' : 'Unavailable'}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="empty-slot"
                          aria-label={`Book ${cellLabel}`}
                          onClick={() => onSelectSlot?.({ date, hour, room: room.id })}
                        >
                          <span aria-hidden="true">+</span><span className="visually-hidden">Book</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
});

export default Schedule;
