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
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setPending(true);
    setError(null);
    try {
      const created = await submitBooking(classId, room, date, hour, 1);
      if (created.length !== 1) throw new Error('unexpected_booking_count');
      onDone();
    } catch (reason) {
      setError(isConflict(reason)
        ? 'Conflict: this slot is no longer available. Refresh the schedule and choose another slot.'
        : 'Unable to book this slot. Please try again.');
    } finally {
      setPending(false);
    }
  };

  const noClasses = !loading && classes.length === 0 && error === null;

  return (
    <section className="booking-form" aria-labelledby="booking-form-title">
      <header>
        <h2 id="booking-form-title">Book a room</h2>
        <p>Book one hourly slot using one of your active classes.</p>
      </header>

      {error && <p className="booking-form__message booking-form__message--error" role="alert">{error}</p>}
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

          <label htmlFor="booking-date">Booking date</label>
          <input
            id="booking-date"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            disabled={pending}
            required
          />

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
              {pending ? 'Booking…' : 'Book slot'}
            </button>
            <button type="button" onClick={onDone} disabled={pending}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
