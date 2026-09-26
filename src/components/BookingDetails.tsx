import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  cancelBooking as cancelBookingApi,
  editBooking as editBookingApi,
  getBookingDetails as getBookingDetailsApi,
  getMyClasses,
} from '../lib/api';
import { getProfile } from '../lib/session';
import { formatAmount, groupPriceSegments } from '../lib/price-breakdown';
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
import Icon from './Icon';

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
  return new Intl.DateTimeFormat('bg-BG', {
    timeZone: 'Europe/Sofia', year: 'numeric', month: 'long', day: 'numeric',
  }).format(new Date(instant));
}

function timeLabel(instant: string | undefined, fallbackHour?: number): string {
  if (!instant) return `${String(fallbackHour ?? 0).padStart(2, '0')}:00`;
  if (instant.endsWith('Z')) {
    return new Intl.DateTimeFormat('bg-BG', {
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
  if (/booking_forbidden|insufficient_privilege/i.test(message)) return 'Нямате право да променяте тази резервация.';
  if (/stale_booking|PT409|version/i.test(message)) return 'Тази резервация е променена другаде. Графикът е обновен — проверете го, преди да опитате отново.';
  if (/cancelled_booking_read_only/i.test(message)) return 'Тази резервация вече е отменена и не може да бъде променяна.';
  if (/network|fetch|timeout|abort/i.test(message) || error instanceof TypeError) return 'Промяната не можа да бъде потвърдена. Графикът е обновен — проверете го, преди да опитате отново.';
  return 'Резервацията не може да бъде променена. Опитайте отново.';
}

function reconcileBooking(current: Booking, updated: Booking, schedule?: DaySchedule): Booking {
  const persisted = schedule?.bookings.find((candidate) => candidate.id === updated.id);
  // Mutation RPCs intentionally return only the safe booking projection. Keep
  // every returned identity/version/position field authoritative and use the
  // schedule response only to restore display labels.
  return {
    ...current,
    ...updated,
    className: persisted?.className || current.className,
    teacherName: persisted?.teacherName || current.teacherName,
    classId: updated.classId || current.classId,
    teacherId: updated.teacherId || current.teacherId,
    version: updated.version ?? current.version,
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
  const groupedSegments = detail ? groupPriceSegments(detail.segments) : [];

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
      if (count === 0) {
        // An empty mutation result is the idempotent "already cancelled"
        // outcome. Hide controls immediately, then reload the private
        // projection for the retained cancellation history; never invent a
        // timestamp from the empty response.
        setCurrentBooking((current) => ({ ...current, canEdit: false }));
        try {
          const authoritative = await loadDetails(currentBooking.id);
          setDetail(authoritative);
          setCurrentBooking({ ...authoritative, canEdit: false });
        } catch {
          // The schedule has already been refreshed. Keep the booking
          // inactive even if the private reload is unavailable.
        }
      } else if (updated) {
        setCurrentBooking(reconcileBooking(currentBooking, updated, refreshed.schedule));
      }
      setConfirming(false);
      setNotice(count === 0
        ? 'Тази резервация вече е била отменена. Графикът е обновен.'
        : `${cancelScope === 'future' ? 'Това и следващите занимания от модула са отменени.' : 'Резервацията е отменена.'}${refreshed.failed ? ' Графикът не можа да бъде обновен.' : ''}`);
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
        editingSeriesLabel={detail ? `Занимание ${detail.seriesIndex + 1} от ${detail.seriesTotal}` : undefined}
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
            ? 'Резервацията е променена, но графикът не можа да бъде обновен.'
            : 'Резервацията е променена.');
        }}
      />
    );
  }

  return (
    <section className="booking-details" aria-label="Резервация" aria-labelledby="booking-details-title">
      <header className="booking-details__header">
        <h2 id="booking-details-title">Резервация</h2>
        <button className="workspace-panel__close" type="button" onClick={onClose} aria-label="Затвори подробностите за резервацията">×</button>
      </header>

      {detailLoading && <p className="booking-details__message" role="status">Зареждат се разрешените подробности за резервацията…</p>}
      {error && <p className="booking-details__message booking-details__message--error" role="alert">{error}</p>}
      {notice && <p className="booking-details__message booking-details__message--success" role="status">{notice}</p>}

      <dl className="booking-details__list">
        <div><dt>Занимание</dt><dd>{currentBooking.className}</dd></div>
        <div><dt>Учител</dt><dd>{currentBooking.teacherName}</dd></div>
        <div><dt>Дата</dt><dd>{formattedDate}</dd></div>
        <div><dt>Час</dt><dd>{formattedStart}–{formattedEnd}</dd></div>
        <div><dt>Зала</dt><dd>{formattedRoom}</dd></div>
        <div><dt>Тип</dt><dd>{detail && (detail.seriesIndex > 0 || detail.hasFutureActive) ? 'Повтарящо се' : 'Еднократно'}</dd></div>
        {detail && <div><dt>Модул</dt><dd>Занимание {detail.seriesIndex + 1} от {detail.seriesTotal}</dd></div>}
        {detail && <div><dt>Бележки за ученика</dt><dd>{detail.studentDetails || 'Няма добавени бележки'}</dd></div>}
        {detail && <div><dt>Цена при запазване</dt><dd>{detail.amount === null ? 'Не е налична' : formatAmount(detail.amount, detail.currency)}</dd></div>}
      </dl>

      {detail && detail.segments.length > 0 && (
        <section className="booking-details__snapshot" aria-label="Разбивка на цената">
          <h3>Разбивка на цената</h3>
          <ul>{groupedSegments.map((segment, index) => <li key={`${segment.rule_id ?? segment.label}:${segment.starts_at}:${index}`}>
            {segment.count > 1 ? `${segment.count}x ` : ''}{segment.label}: {formatAmount(segment.subtotal, detail.currency)} ({segment.starts_at.slice(11, 16)}–{segment.ends_at.slice(11, 16)})
          </li>)}</ul>
        </section>
      )}

      {cancelled && (
        <p className="booking-details__history">
          Отменена на {readableDate(currentBooking.cancelledAt as string)}
          {currentBooking.cancelledBy ? ` от ${currentBooking.cancelledBy}` : ''}.
        </p>
      )}

      {canManage && (
        <div className="booking-details__actions">
          <button type="button" onClick={() => { setError(null); setNotice(null); setEditing(true); }} className="icon-button" disabled={pending} aria-label="Промени резервацията" title="Промени резервацията"><Icon name="pencil" /></button>
          <button ref={cancelTriggerRef} type="button" onClick={() => { setCancelScope('one'); setError(null); setNotice(null); setConfirming(true); }} className="icon-button" disabled={pending} aria-label="Отмени резервацията" title="Отмени резервацията"><Icon name="trash" /></button>
        </div>
      )}

      {offline && !cancelled && (
        <p className="booking-details__message booking-details__message--offline" role="alert">
          Няма връзка с интернет. Промяната и отмяната са изключени до възстановяване на връзката.
        </p>
      )}

      {confirming && typeof document !== 'undefined' && createPortal(
        <div className="booking-details__confirm-backdrop">
          <div ref={confirmationRef} className="booking-details__confirm" role="dialog" aria-modal="true" aria-labelledby="cancel-booking-title" onKeyDown={handleConfirmationKeyDown}>
          <h3 id="cancel-booking-title">Да отменим ли тази резервация?</h3>
          <p>
            Да отменим ли „{currentBooking.className}“ на {formattedDate} в {formattedStart} в {formattedRoom}?
            Изберете кои активни занимания да бъдат отменени. Промяната засяга само това занимание.
          </p>
          <fieldset>
            <legend>Обхват на отмяната</legend>
            <label><input type="radio" name="cancel-scope" checked={cancelScope === 'one'} onChange={() => setCancelScope('one')} disabled={pending} /> Само това занимание</label>
            {hasFutureActive && <label><input type="radio" name="cancel-scope" checked={cancelScope === 'future'} onChange={() => setCancelScope('future')} disabled={pending} /> Това и следващите занимания</label>}
          </fieldset>
          <div className="booking-details__actions">
            <button type="button" onClick={() => void handleCancel()} disabled={pending || offline}>
              {pending ? 'Отменяне…' : 'Потвърди отмяната'}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending}>Запази резервацията</button>
          </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
