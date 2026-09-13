import { useEffect, useState } from 'react';
import { getMyClasses, scheduleBookings } from '../lib/api';
import { getProfile } from '../lib/session';
import type { Booking, ClassItem, Profile, Room } from '../lib/types';

type ClassLoader = () => Promise<ClassItem[]>;
type BookingSubmitter = (
  classId: string,
  room: Room,
  date: string,
  hour: number,
  occurrences?: number,
  weekday?: number,
) => Promise<Booking[]>;

export interface BookingFormProps {
  date: string;
  hour: number;
  room: Room;
  existingBooking?: Booking;
  onDone: () => void;
  profile?: Profile | null;
  loadClasses?: ClassLoader;
  submitBooking?: BookingSubmitter;
}

const ROOMS: readonly { id: Room; label: string }[] = [
  { id: 'room_1', label: 'Room 1' },
  { id: 'room_2', label: 'Room 2' },
];

const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

function isConflict(error: unknown): boolean {
  if (error === 'booking_conflict') return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === 'PT409' || value.code === 'booking_conflict' || value.message === 'booking_conflict';
}

function localDateOf(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isoWeekdayOf(date: string): number {
  const parts = date.split('-').map(Number);
  const year = parts[0] ?? Number.NaN;
  const month = parts[1] ?? Number.NaN;
  const day = parts[2] ?? Number.NaN;
  if (![year, month, day].every(Number.isFinite)) return 1;
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return utcDay === 0 ? 7 : utcDay;
}

function conflictDates(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];
  const details = (error as { details?: unknown }).details;
  let values: unknown = details;
  if (typeof details === 'string') {
    try {
      values = JSON.parse(details);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(values)) return [];
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return [value];
    if (!Number.isNaN(new Date(value).getTime())) return [localDateOf(value)];
    return [];
  }))];
}

function countMismatch(requested: number, received: number): string {
  return `Weekly booking count mismatch: expected ${requested}, but received ${received}. Please refresh before trying again.`;
}

export default function BookingForm({
  date: selectedDate,
  hour: selectedHour,
  room: selectedRoom,
  existingBooking,
  onDone,
  profile: suppliedProfile,
  loadClasses = getMyClasses,
  submitBooking = scheduleBookings,
}: BookingFormProps) {
  const profile = suppliedProfile ?? getProfile();
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [classId, setClassId] = useState(existingBooking?.classId ?? '');
  const [date, setDate] = useState(existingBooking ? localDateOf(existingBooking.startsAt) : selectedDate);
  const [hour, setHour] = useState(existingBooking?.hour ?? selectedHour);
  const [room, setRoom] = useState<Room>(existingBooking?.room ?? selectedRoom);
  const [weekly, setWeekly] = useState(false);
  const [weekday, setWeekday] = useState(isoWeekdayOf(existingBooking ? localDateOf(existingBooking.startsAt) : selectedDate));
  const [occurrences, setOccurrences] = useState('1');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    void loadClasses().then((items) => {
      if (!mounted) return;
      const ownActive = items.filter((item) => item.active &&
        (profile?.role === 'admin' || item.teacherId === profile?.id));
      setClasses(ownActive);
      setClassId((current) => ownActive.some((item) => item.id === current)
        ? current
        : (ownActive[0]?.id ?? ''));
    }).catch(() => {
      if (mounted) setError('Unable to load classes. Please try again.');
    }).finally(() => {
      if (mounted) setLoading(false);
    });
    return () => { mounted = false; };
  }, [loadClasses, profile?.id, profile?.role]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!classId || pending) return;

    const requested = weekly ? Number(occurrences) : 1;
    if (weekly && (!Number.isInteger(requested) || requested < 1 || requested > 104)) {
      setError('Enter between 1 and 104 whole weekly bookings.');
      return;
    }
    if (weekly && isoWeekdayOf(date) !== weekday) {
      setError('The selected weekday must match the first booking date.');
      return;
    }

    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await submitBooking(
        classId, room, date, hour, requested, weekly ? weekday : undefined,
      );
      if (created.length !== requested) throw new Error(`count_mismatch:${requested}:${created.length}`);
      setSuccess(weekly
        ? `Created ${created.length} weekly bookings.`
        : 'Created 1 booking.');
      onDone();
    } catch (reason) {
      const match = reason instanceof Error && reason.message.match(/^count_mismatch:(\d+):(\d+)$/);
      if (match) {
        setError(countMismatch(Number(match[1]), Number(match[2])));
      } else if (isConflict(reason)) {
        const dates = conflictDates(reason);
        setError(weekly && dates.length > 0
          ? `Conflict dates: ${dates.join(', ')}. All weekly bookings were left unchanged.`
          : 'Conflict: this slot is no longer available. Refresh the schedule and choose another slot.');
      } else {
        setError(weekly
          ? 'Unable to create weekly bookings. Please try again.'
          : 'Unable to book this slot. Please try again.');
      }
    } finally {
      setPending(false);
    }
  };

  const noClasses = !loading && classes.length === 0 && error === null;
  const editing = Boolean(existingBooking);

  return (
    <section className="booking-form" aria-labelledby="booking-form-title">
      <header>
        <h2 id="booking-form-title">Book a room</h2>
        <p>{weekly ? 'Book the same class and room every week.' : 'Book one hourly slot using one of your active classes.'}</p>
      </header>

      {error && <p className="booking-form__message booking-form__message--error" role="alert">{error}</p>}
      {success && <p className="booking-form__message booking-form__message--success" role="status">{success}</p>}
      {loading && <p role="status">Loading your active classes…</p>}
      {noClasses && (
        <p className="booking-form__message" role="status">
          Create an active class before booking a room.
        </p>
      )}

      {!loading && !noClasses && (
        <form onSubmit={handleSubmit}>
          <label htmlFor="booking-class">Class</label>
          <select
            id="booking-class"
            value={classId}
            onChange={(event) => setClassId(event.target.value)}
            disabled={pending}
          >
            {classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>

          <label className="booking-form__checkbox" htmlFor="booking-weekly">
            <input
              id="booking-weekly"
              type="checkbox"
              checked={weekly}
              onChange={(event) => setWeekly(event.target.checked)}
              disabled={pending || editing}
            />
            Book weekly
          </label>

          {weekly && (
            <p className="booking-form__help">All weekly bookings succeed or none are created.</p>
          )}

          <label htmlFor="booking-date">{weekly ? 'First booking date' : 'Booking date'}</label>
          <input
            id="booking-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            disabled={pending}
            required
          />

          {weekly && (
            <>
              <label htmlFor="booking-weekday">Weekday</label>
              <select
                id="booking-weekday"
                value={weekday}
                onChange={(event) => setWeekday(Number(event.target.value))}
                disabled={pending}
              >
                {WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}
              </select>

              <label htmlFor="booking-occurrences">Number of weekly bookings</label>
              <input
                id="booking-occurrences"
                type="number"
                min={1}
                max={104}
                step={1}
                value={occurrences}
                onChange={(event) => setOccurrences(event.target.value)}
                disabled={pending}
                required
              />
            </>
          )}

          <label htmlFor="booking-hour">Booking hour</label>
          <input
            id="booking-hour"
            type="number"
            min={0}
            max={23}
            step={1}
            value={hour}
            onChange={(event) => setHour(Number(event.target.value))}
            disabled={pending}
            required
          />

          <label htmlFor="booking-room">Room</label>
          <select
            id="booking-room"
            value={room}
            onChange={(event) => setRoom(event.target.value as Room)}
            disabled={pending}
          >
            {ROOMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>

          <div className="booking-form__actions">
            <button type="submit" disabled={pending || !classId}>
              {pending ? 'Booking…' : weekly ? 'Book weekly bookings' : 'Book slot'}
            </button>
            <button type="button" onClick={onDone} disabled={pending}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
