import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  cancelBooking as cancelBookingApi,
  editBooking as editBookingApi,
  getBookingDetails as getBookingDetailsApi,
  getMyClasses,
} from '../lib/api';
import { getProfile } from '../lib/session';
import type {
  Booking,
  BookingDetail,
  CancelScope,
  CancellationResult,
  ClassItem,
  DaySchedule,
  Profile,
  Room,
} from '../lib/types';
import BookingForm from './BookingForm';

type ClassLoader = () => Promise<ClassItem[]>;
type DetailLoader = (id: string) => Promise<BookingDetail>;
type BookingEditor = (
  id: string,
  expectedVersion: number,
  classId: string,
  room: Room,
  startsAt: string,
  endsAt: string,
  studentDetails: string | null,
) => Promise<Booking>;
type BookingCanceller = (
  id: string,
  expectedVersion: number,
  scope: CancelScope,
) => Promise<CancellationResult | Booking>;

export interface BookingDetailsProps {
  booking: Booking;
  onClose: () => void;
  onRefresh: () => Promise<DaySchedule | void> | DaySchedule | void;
  profile?: Profile | null;
  loadClasses?: ClassLoader;
  loadDetails?: DetailLoader;
  editBooking?: BookingEditor;
  cancelBooking?: BookingCanceller;
  offline?: boolean;
}

function localDate(instant: string): string {
  return instant.slice(0, 10);
}

function readableDate(instant: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date(instant));
}

function timeLabel(instant: string | undefined, fallbackHour?: number): string {
  if (!instant) return `${String(fallbackHour ?? 0).padStart(2, '0')}:00`;
  if (instant.endsWith('Z')) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(instant));
  }
  return instant.slice(11, 16);
}

function roomLabel(room: Room): string {
  return room === 'hall' ? 'Зала' : 'Стая';
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; message?: unknown };
  return `${typeof value.code === 'string' ? value.code : ''} ${typeof value.message === 'string' ? value.message : ''}`;
}

function mutationError(error: unknown): string {
  const message = errorMessage(error);
  if (/booking_forbidden|insufficient_privilege/i.test(message)) return 'You are not authorized to change this booking.';
  if (/stale_booking|PT409|version/i.test(message)) return 'This booking changed elsewhere. The schedule was refreshed; review it before trying again.';
  if (/cancelled_booking_read_only/i.test(message)) return 'This booking is already cancelled and cannot be changed.';
  if (/network|fetch|timeout|abort/i.test(message) || error instanceof TypeError) return 'We could not confirm the change. The schedule was refreshed; review it before trying again.';
  return 'Unable to change this booking. Please try again.';
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

function isCancellationResult(value: CancellationResult | Booking): value is CancellationResult {
  return 'cancelledCount' in value && 'bookings' in value;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
}

export default function BookingDetails({
  booking,
  onClose,
  onRefresh,
  profile: suppliedProfile,
  loadClasses = getMyClasses,
  loadDetails = getBookingDetailsApi,
  editBooking = editBookingApi,
  cancelBooking = cancelBookingApi,
  offline = false,
}: BookingDetailsProps) {
  const profile = suppliedProfile ?? getProfile();
  const shouldLoadDetails = booking.canEdit && (booking.version === 0 || loadDetails !== getBookingDetailsApi);
  const [currentBooking, setCurrentBooking] = useState<Booking>(booking);
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(shouldLoadDetails);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelScope, setCancelScope] = useState<CancelScope>('one');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirming) return undefined;

    const confirmation = confirmationRef.current;
    const parentDialog = cancelTriggerRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    const previousAriaHidden = parentDialog ? parentDialog.getAttribute('aria-hidden') : null;
    const previousInert = parentDialog?.hasAttribute('inert') ?? false;
    if (parentDialog) {
      parentDialog.setAttribute('aria-hidden', 'true');
      parentDialog.setAttribute('inert', '');
      (parentDialog as HTMLElement & { inert?: boolean }).inert = true;
    }
    confirmation?.querySelector<HTMLElement>('button:not([disabled])')?.focus();

    return () => {
      if (parentDialog) {
        if (previousAriaHidden === null) parentDialog.removeAttribute('aria-hidden');
        else parentDialog.setAttribute('aria-hidden', previousAriaHidden);
        if (!previousInert) parentDialog.removeAttribute('inert');
        (parentDialog as HTMLElement & { inert?: boolean }).inert = previousInert;
      }
      cancelTriggerRef.current?.focus();
    };
  }, [confirming]);

  useEffect(() => {
    setCurrentBooking(booking);
    setDetail(null);
    if (!shouldLoadDetails) {
      setDetailLoading(false);
      return undefined;
    }
    let mounted = true;
    setDetailLoading(true);
    void loadDetails(booking.id).then((loaded) => {
      if (mounted) {
        setDetail(loaded);
        setCurrentBooking(loaded);
      }
    }).catch(() => {
      // Keep the public summary visible, but do not invent private fields.
    }).finally(() => {
      if (mounted) setDetailLoading(false);
    });
    return () => { mounted = false; };
  }, [booking, loadDetails, shouldLoadDetails]);

  const cancelled = currentBooking.cancelledAt !== null;
  // get_day deliberately carries version 0. Controls are available from a
  // test/detail projection only, never from an unhydrated safe schedule row.
  const canManage = currentBooking.canEdit && !cancelled && !offline && (!detailLoading && (detail !== null || currentBooking.version > 0));
  const hasFutureActive = detail?.hasFutureActive === true;
  const formattedDate = readableDate(currentBooking.startsAt);
  const formattedStart = timeLabel(currentBooking.startsAt);
  const formattedEnd = timeLabel(currentBooking.endsAt, currentBooking.hour + 1);
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
      let result: CancellationResult | Booking;
      try {
        result = await cancelBooking(currentBooking.id, currentBooking.version, cancelScope);
      } catch (reason) {
        const refreshed = await refreshSchedule();
        setError(`${mutationError(reason)}${refreshed.failed ? ' Schedule refresh failed.' : ''}`);
        return;
      }
      const count = isCancellationResult(result) ? result.cancelledCount : (result.cancelledAt ? 1 : 0);
      const updated = isCancellationResult(result) ? result.bookings[0] : result;
      const refreshed = await refreshSchedule();
      if (updated) setCurrentBooking(reconcileBooking(currentBooking, updated, refreshed.schedule));
      setConfirming(false);
      setNotice(count === 0
        ? 'This booking was already cancelled. The schedule was refreshed.'
        : `${cancelScope === 'future' ? 'This booking and later bookings were cancelled.' : 'Booking cancelled.'}${refreshed.failed ? ' Schedule refresh failed.' : ''}`);
    } finally {
      setPending(false);
    }
  };

  const handleConfirmationKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!pending) setConfirming(false);
      return;
    }
    if (event.key !== 'Tab' || !confirmationRef.current) return;
    const focusable = focusableElements(confirmationRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === confirmationRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (editing && canManage) {
    return (
      <BookingForm
        date={localDate(currentBooking.startsAt)}
        startsAt={currentBooking.startsAt}
        room={currentBooking.room}
        existingBooking={currentBooking}
        profile={profile}
        loadClasses={loadClasses}
        editBooking={editBooking}
        onRefresh={onRefresh}
        offline={offline}
        onCancel={() => setEditing(false)}
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
    <section className="booking-details" aria-label="Booking details" aria-labelledby="booking-details-title">
      <header className="booking-details__header">
        <h2 id="booking-details-title">Booking details</h2>
        <button type="button" onClick={onClose} aria-label="Close booking details">×</button>
      </header>

      {detailLoading && <p className="booking-details__message" role="status">Loading authorized booking details…</p>}
      {error && <p className="booking-details__message booking-details__message--error" role="alert">{error}</p>}
      {notice && <p className="booking-details__message booking-details__message--success" role="status">{notice}</p>}

      <dl className="booking-details__list">
        <div><dt>Class</dt><dd>{currentBooking.className}</dd></div>
        <div><dt>Teacher</dt><dd>{currentBooking.teacherName}</dd></div>
        <div><dt>Date</dt><dd>{formattedDate}</dd></div>
        <div><dt>Time</dt><dd>{formattedStart}–{formattedEnd}</dd></div>
        <div><dt>Room</dt><dd>{formattedRoom}</dd></div>
        <div><dt>Type</dt><dd>One booking instance</dd></div>
        {detail && <div><dt>Series</dt><dd>{detail.seriesIndex + 1} of series {detail.seriesId}</dd></div>}
        {detail && <div><dt>Student details</dt><dd>{detail.studentDetails || 'None provided'}</dd></div>}
        {detail && <div><dt>Snapshot amount</dt><dd>{detail.amount === null ? 'Unavailable' : `${detail.currency} ${detail.amount}`}</dd></div>}
      </dl>

      {detail && detail.segments.length > 0 && (
        <section className="booking-details__snapshot" aria-label="Price breakdown">
          <h3>Price breakdown</h3>
          <ul>{detail.segments.map((segment) => <li key={`${segment.starts_at}:${segment.ends_at}`}>
            {segment.label}: {segment.subtotal} ({segment.starts_at.slice(11, 16)}–{segment.ends_at.slice(11, 16)})
          </li>)}</ul>
        </section>
      )}

      {cancelled && (
        <p className="booking-details__history">
          Cancelled on {readableDate(currentBooking.cancelledAt as string)}
          {currentBooking.cancelledBy ? ` by ${currentBooking.cancelledBy}` : ''}.
        </p>
      )}

      {canManage && (
        <div className="booking-details__actions">
          <button type="button" onClick={() => { setError(null); setNotice(null); setEditing(true); }} disabled={pending}>
            Edit booking
          </button>
          <button ref={cancelTriggerRef} type="button" onClick={() => { setCancelScope('one'); setError(null); setNotice(null); setConfirming(true); }} disabled={pending}>
            Cancel booking
          </button>
        </div>
      )}

      {offline && !cancelled && (
        <p className="booking-details__message booking-details__message--offline" role="alert">
          You are offline. Editing and cancellation are disabled until the connection is restored.
        </p>
      )}

      {confirming && typeof document !== 'undefined' && createPortal(
        <div ref={confirmationRef} className="booking-details__confirm" role="dialog" aria-modal="true" aria-labelledby="cancel-booking-title" onKeyDown={handleConfirmationKeyDown}>
          <h3 id="cancel-booking-title">Cancel this booking?</h3>
          <p>
            Cancel “{currentBooking.className}” on {formattedDate} at {formattedStart} in {formattedRoom}?
            Choose exactly which active occurrences to cancel. Editing always affects this occurrence only.
          </p>
          <fieldset>
            <legend>Cancellation scope</legend>
            <label><input type="radio" name="cancel-scope" checked={cancelScope === 'one'} onChange={() => setCancelScope('one')} disabled={pending} /> Only this occurrence</label>
            {hasFutureActive && <label><input type="radio" name="cancel-scope" checked={cancelScope === 'future'} onChange={() => setCancelScope('future')} disabled={pending} /> This and later occurrences</label>}
          </fieldset>
          <div className="booking-details__actions">
            <button type="button" onClick={() => void handleCancel()} disabled={pending || offline}>
              {pending ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending}>Keep booking</button>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
