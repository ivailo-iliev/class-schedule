import { useEffect, useState } from 'react';
import {
  cancelBooking as cancelBookingApi,
  editBooking as editBookingApi,
  getMyClasses,
} from '../lib/api';
import { getProfile } from '../lib/session';
import type { Booking, ClassItem, DaySchedule, Profile, Room } from '../lib/types';
import BookingForm from './BookingForm';

type ClassLoader = () => Promise<ClassItem[]>;
type BookingEditor = (
  id: string,
  expectedVersion: number,
  classId: string,
  room: Room,
  date: string,
  hour: number,
) => Promise<Booking>;
type BookingCanceller = (id: string, expectedVersion: number) => Promise<Booking>;

export interface BookingDetailsProps {
  booking: Booking;
  onClose: () => void;
  onRefresh: () => Promise<DaySchedule | void> | DaySchedule | void;
  profile?: Profile | null;
  loadClasses?: ClassLoader;
  editBooking?: BookingEditor;
  cancelBooking?: BookingCanceller;
  offline?: boolean;
}

function localDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function readableDate(instant: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date(instant));
}

function hourLabel(booking: Booking): string {
  return `${booking.hour.toString().padStart(2, '0')}:00`;
}

function roomLabel(room: Room): string {
  return room === 'hall' ? 'Зала' : 'Стая';
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; message?: unknown };
  return `${typeof value.code === 'string' ? value.code : ''} ${typeof value.message === 'string' ? value.message : ''}`;
}

function isConflict(error: unknown): boolean {
  return error === 'booking_conflict' || /PT409|booking_conflict|stale_booking|version/i.test(errorMessage(error));
}

function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return /network|fetch|timeout|timed out|abort/i.test(errorMessage(error));
}

function isStale(error: unknown): boolean {
  return /stale_booking|version/i.test(errorMessage(error));
}

function reconcileBooking(current: Booking, updated: Booking, schedule?: DaySchedule): Booking {
  const persisted = schedule?.bookings.find((candidate) => candidate.id === updated.id);
  const candidate = persisted ?? updated;
  return {
    ...current,
    ...candidate,
    className: candidate.className || current.className,
    teacherName: candidate.teacherName || current.teacherName,
    teacherId: candidate.teacherId || current.teacherId,
  };
}

export default function BookingDetails({
  booking,
  onClose,
  onRefresh,
  profile: suppliedProfile,
  loadClasses = getMyClasses,
  editBooking = editBookingApi,
  cancelBooking = cancelBookingApi,
  offline = false,
}: BookingDetailsProps) {
  const profile = suppliedProfile ?? getProfile();
  const [currentBooking, setCurrentBooking] = useState(booking);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setCurrentBooking(booking);
  }, [booking]);

  const cancelled = currentBooking.cancelledAt !== null;
  const canEdit = currentBooking.canEdit && !cancelled && !offline;
  const formattedDate = readableDate(currentBooking.startsAt);
  const formattedHour = hourLabel(currentBooking);
  const formattedRoom = roomLabel(currentBooking.room);

  const refreshSchedule = async (): Promise<{ schedule?: DaySchedule; failed: boolean }> => {
    try {
      const result = await onRefresh();
      return { schedule: result && 'bookings' in result ? result : undefined, failed: false };
    } catch {
      return { failed: true };
    }
  };

  const handleCancel = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      let updated: Booking;
      try {
        updated = await cancelBooking(currentBooking.id, currentBooking.version);
      } catch (reason) {
        const refreshed = await refreshSchedule();
        setError(isUnknownOutcome(reason)
          ? `We could not confirm the cancellation. ${refreshed.failed ? 'The schedule refresh failed; ' : 'The schedule was refreshed; '}review it before trying again.`
          : isStale(reason)
            ? `This booking changed elsewhere. ${refreshed.failed ? 'The schedule refresh failed; ' : 'The schedule was refreshed; '}review it before trying again.`
            : isConflict(reason)
              ? `This booking conflicts with a newer schedule change. ${refreshed.failed ? 'The schedule refresh failed; ' : 'The schedule was refreshed; '}review it before trying again.`
              : 'Unable to cancel this booking. Please try again.');
        return;
      }
      const refreshed = await refreshSchedule();
      setCurrentBooking(reconcileBooking(currentBooking, updated, refreshed.schedule));
      setConfirming(false);
      setNotice(refreshed.failed
        ? 'Booking cancelled, but the schedule could not be refreshed.'
        : 'Booking cancelled.');
    } finally {
      setPending(false);
    }
  };

  if (editing && canEdit) {
    return (
      <BookingForm
        date={localDate(currentBooking.startsAt)}
        hour={currentBooking.hour}
        room={currentBooking.room}
        existingBooking={currentBooking}
        profile={profile}
        loadClasses={loadClasses}
        editBooking={editBooking}
        onRefresh={onRefresh}
        offline={offline}
        onDone={(updated, refreshed, refreshFailed) => {
          if (updated) setCurrentBooking(reconcileBooking(currentBooking, updated, refreshed));
          setEditing(false);
          setNotice(refreshFailed
            ? 'Booking updated, but the schedule could not be refreshed.'
            : 'Booking updated.');
        }}
      />
    );
  }

  return (
    <section className="booking-details" aria-label="Booking details">
      <header className="booking-details__header">
        <button type="button" onClick={onClose} aria-label="Close booking details">×</button>
      </header>

      {error && <p className="booking-details__message booking-details__message--error" role="alert">{error}</p>}
      {notice && <p className="booking-details__message booking-details__message--success" role="status">{notice}</p>}

      <dl className="booking-details__list">
        <div><dt>Class</dt><dd>{currentBooking.className}</dd></div>
        <div><dt>Teacher</dt><dd>{currentBooking.teacherName}</dd></div>
        <div><dt>Date</dt><dd>{formattedDate}</dd></div>
        <div><dt>Hour</dt><dd>{formattedHour}</dd></div>
        <div><dt>Room</dt><dd>{formattedRoom}</dd></div>
        <div><dt>Type</dt><dd>One booking instance</dd></div>
      </dl>

      {cancelled && (
        <p className="booking-details__history">
          Cancelled on {readableDate(currentBooking.cancelledAt as string)}
          {currentBooking.cancelledBy ? ` by ${currentBooking.cancelledBy}` : ''}.
        </p>
      )}

      {canEdit && (
        <div className="booking-details__actions">
          <button type="button" onClick={() => { setError(null); setNotice(null); setEditing(true); }} disabled={pending}>
            Edit booking
          </button>
          <button type="button" onClick={() => { setError(null); setNotice(null); setConfirming(true); }} disabled={pending}>
            Cancel booking
          </button>
        </div>
      )}

      {offline && !cancelled && (
        <p className="booking-details__message booking-details__message--offline" role="alert">
          You are offline. Editing and cancellation are disabled until the connection is restored.
        </p>
      )}

      {confirming && (
        <div className="booking-details__confirm" role="dialog" aria-modal="true" aria-labelledby="cancel-booking-title">
          <h3 id="cancel-booking-title">Cancel this booking?</h3>
          <p>
            Cancel “{currentBooking.className}” on {formattedDate} at {formattedHour} in {formattedRoom}?
            This cancels one instance only.
          </p>
          <div className="booking-details__actions">
            <button type="button" onClick={() => void handleCancel()} disabled={pending || offline}>
              {pending ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending}>Keep booking</button>
          </div>
        </div>
      )}
    </section>
  );
}
