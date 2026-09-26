import { useEffect, useMemo, useState } from 'react';
import {
  createBookingSeries as createBookingSeriesApi,
  getMyClasses,
  getTeachers,
  quoteBooking as quoteBookingApi,
} from '../lib/api';
import { localTime, minutesOf } from '../lib/calendar';
import { getProfile } from '../lib/session';
import type {
  Booking,
  BookingOccurrence,
  BookingQuote,
  ClassItem,
  CreatedBookingSeries,
  DaySchedule,
  Profile,
  Room,
} from '../lib/types';

type ClassLoader = () => Promise<ClassItem[]>;
type TeacherLoader = () => Promise<Profile[]>;
type QuoteLoader = (classId: string, room: Room, occurrences: BookingOccurrence[]) => Promise<BookingQuote>;
type SeriesCreator = (
  classId: string,
  room: Room,
  studentDetails: string | null,
  occurrences: BookingOccurrence[],
) => Promise<CreatedBookingSeries>;
type BookingEditor = (
  id: string,
  expectedVersion: number,
  classId: string,
  room: Room,
  startsAt: string,
  endsAt: string,
  studentDetails: string | null,
) => Promise<Booking>;

export interface BookingFormProps {
  date: string;
  room: Room;
  startsAt?: string;
  endsAt?: string;
  /** Kept for the details editor and older callers; new creation uses startsAt. */
  hour?: number;
  existingBooking?: Booking;
  /** Immutable context shown while editing an existing occurrence. */
  editingSeriesLabel?: string;
  onDone: (updated?: Booking, refreshed?: DaySchedule, refreshFailed?: boolean) => void;
  onCancel?: () => void;
  profile?: Profile | null;
  loadClasses?: ClassLoader;
  loadTeachers?: TeacherLoader;
  quoteBooking?: QuoteLoader;
  createBookingSeries?: SeriesCreator;
  editBooking?: BookingEditor;
  /** @deprecated Old weekly mutation injection; creation no longer calls it. */
  submitBooking?: (...args: unknown[]) => Promise<Booking[]>;
  onRefresh?: () => Promise<DaySchedule | void> | DaySchedule | void;
  offline?: boolean;
}

const ROOMS: readonly { id: Room; label: string }[] = [
  { id: 'hall', label: 'Зала' },
  { id: 'room', label: 'Стая' },
];
const BOOKING_START_MINUTES = 8 * 60;
const BOOKING_END_MINUTES = 22 * 60;
const TIME_OPTIONS: readonly string[] = Array.from({ length: (BOOKING_END_MINUTES - BOOKING_START_MINUTES) / 30 + 1 }, (_, index) => {
  const totalMinutes = BOOKING_START_MINUTES + index * 30;
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
});
const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Понеделник' },
  { value: 2, label: 'Вторник' },
  { value: 3, label: 'Сряда' },
  { value: 4, label: 'Четвъртък' },
  { value: 5, label: 'Петък' },
  { value: 6, label: 'Събота' },
  { value: 7, label: 'Неделя' },
];
const MAX_OCCURRENCES = 104;
const QUOTE_DEBOUNCE_MS = 300;

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month! - 1 && value.getUTCDate() === day;
}

function todayDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isoWeekday(date: string): number {
  if (!validDate(date)) return 1;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mondayOf(date: string): string {
  return shiftDate(date, 1 - isoWeekday(date));
}

function timeFromStartsAt(startsAt: string | undefined, hour: number | undefined): string {
  if (startsAt) return startsAt.slice(11, 16);
  return `${String(hour ?? 8).padStart(2, '0')}:00`;
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):(?:00|30)$/.test(value);
}

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

function addMinutes(value: string, amount: number): string {
  const next = minutes(value) + amount;
  return `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
}

export function buildOccurrences(
  mode: 'one-off' | 'recurring',
  date: string,
  startTime: string,
  endTime: string,
  weekStart: string,
  weekdays: number[],
  weeks: string,
): { occurrences: BookingOccurrence[]; error: string | null } {
  if (!validDate(date) || (mode === 'recurring' && !validDate(weekStart))) {
    return { occurrences: [], error: 'Изберете валидна дата.' };
  }
  const minimumDate = mode === 'recurring' ? mondayOf(todayDate()) : todayDate();
  const requestedDate = mode === 'recurring' ? weekStart : date;
  if (requestedDate < minimumDate) {
    return { occurrences: [], error: 'Датата на резервацията не може да бъде в миналото.' };
  }
  if (!validTime(startTime) || !validTime(endTime) || minutes(startTime) < BOOKING_START_MINUTES || minutes(endTime) > BOOKING_END_MINUTES || minutes(endTime) <= minutes(startTime)) {
    return { occurrences: [], error: 'Началният и крайният час трябва да са между 08:00 и 22:00, да са различни и да са в един и същи ден. Използвайте интервали от 30 минути.' };
  }
  if (mode === 'one-off') {
    return {
      occurrences: [{ starts_at: localTime(date, minutes(startTime)), ends_at: localTime(date, minutes(endTime)) }],
      error: null,
    };
  }
  const countWeeks = Number(weeks);
  const selected = [...new Set(weekdays)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b);
  if (!Number.isInteger(countWeeks) || countWeeks < 1 || countWeeks > 52 || selected.length === 0) {
    return { occurrences: [], error: 'Изберете поне един ден от седмицата и период от 1 до 52 седмици.' };
  }
  const count = countWeeks * selected.length;
  if (count > MAX_OCCURRENCES) return { occurrences: [], error: 'Повтарящата се резервация може да съдържа най-много 104 занимания.' };
  const occurrences: BookingOccurrence[] = [];
  for (let week = 0; week < countWeeks; week += 1) {
    for (const day of selected) {
      const occurrenceDate = shiftDate(weekStart, week * 7 + day - 1);
      occurrences.push({
        starts_at: localTime(occurrenceDate, minutes(startTime)),
        ends_at: localTime(occurrenceDate, minutes(endTime)),
      });
    }
  }
  return { occurrences, error: null };
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; message?: unknown };
  return `${typeof value.code === 'string' ? value.code : ''} ${typeof value.message === 'string' ? value.message : ''}`;
}

function money(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : `€${value}`;
}

function isConflict(error: unknown): boolean {
  return /PT409|booking_conflict|conflict/i.test(errorText(error));
}

function displayTime(value: string): string {
  return value.slice(11, 16);
}

function createdTotal(result: CreatedBookingSeries): string | null {
  if (typeof result.total_amount === 'string' && /^\d+(?:\.\d{2})$/.test(result.total_amount)) return result.total_amount;
  return null;
}

export default function BookingForm({
  date: selectedDate,
  room: selectedRoom,
  startsAt: selectedStartsAt,
  endsAt: selectedEndsAt,
  hour: selectedHour,
  existingBooking,
  editingSeriesLabel,
  onDone,
  onCancel,
  profile: suppliedProfile,
  loadClasses = getMyClasses,
  loadTeachers = getTeachers,
  quoteBooking = quoteBookingApi,
  createBookingSeries = createBookingSeriesApi,
  editBooking,
  onRefresh,
  offline = false,
}: BookingFormProps) {
  const profile = suppliedProfile ?? getProfile();
  const editing = Boolean(existingBooking);
  const minimumDate = todayDate();
  const requestedDate = existingBooking?.startsAt.slice(0, 10) ?? selectedDate;
  const initialDate = existingBooking ? requestedDate : (requestedDate < minimumDate ? minimumDate : requestedDate);
  const initialStart = existingBooking
    ? (existingBooking.startsAt.endsWith('Z')
      ? `${String(existingBooking.hour).padStart(2, '0')}:00`
      : timeFromStartsAt(existingBooking.startsAt, existingBooking.hour))
    : timeFromStartsAt(selectedStartsAt, selectedHour);
  const initialEnd = existingBooking?.endsAt
    ? existingBooking.endsAt.slice(11, 16)
    : selectedEndsAt
      ? selectedEndsAt.slice(11, 16)
      : addMinutes(initialStart, 30);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<Profile[]>([]);
  const [teacherId, setTeacherId] = useState(existingBooking?.teacherId ?? profile?.id ?? '');
  const [classId, setClassId] = useState(existingBooking?.classId ?? '');
  const [date, setDate] = useState(initialDate);
  const [weekStart, setWeekStart] = useState(mondayOf(initialDate));
  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);
  const [room, setRoom] = useState<Room>(existingBooking?.room ?? selectedRoom);
  const [mode, setMode] = useState<'one-off' | 'recurring'>('one-off');
  const [weekdays, setWeekdays] = useState<number[]>([isoWeekday(initialDate)]);
  const [weeks, setWeeks] = useState('1');
  const [studentDetails, setStudentDetails] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const requestId = useState({ value: 0 })[0];
  const timeOptions = editing
    ? Array.from(new Set([...TIME_OPTIONS, initialStart, initialEnd])).sort()
    : TIME_OPTIONS;

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    const load = async () => {
      if (!editing) {
        if (profile?.role === 'admin') {
          const availableTeachers = await loadTeachers();
          if (!mounted) return;
          setTeachers(availableTeachers);
          setTeacherId((current) => availableTeachers.some((item) => item.id === current)
            ? current : (availableTeachers[0]?.id ?? ''));
        }
      }
      const items = await loadClasses();
      if (!mounted) return;
      setClasses(items);
      setClassId((current) => items.some((item) => item.id === current)
        ? current : (items.some((item) => item.id === existingBooking?.classId) ? existingBooking!.classId : ''));
    };
    void load().catch(() => { if (mounted) setError('Активните занимания не могат да бъдат заредени. Опитайте отново.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [loadClasses, loadTeachers, profile?.role]);

  const availableClasses = useMemo(() => classes.filter((item) =>
    (item.active || (editing && item.id === existingBooking?.classId)) &&
    (profile?.role === 'admin' ? item.teacherId === teacherId : item.teacherId === profile?.id)),
  [classes, editing, existingBooking?.classId, profile?.id, profile?.role, teacherId]);

  useEffect(() => {
    if (editing) return;
    setClassId((current) => availableClasses.some((item) => item.id === current)
      ? current : (availableClasses[0]?.id ?? ''));
  }, [availableClasses, editing]);

  const generated = useMemo(() => buildOccurrences(mode, date, startTime, endTime, weekStart, weekdays, weeks),
    [date, endTime, mode, startTime, weekStart, weekdays, weeks]);
  const occurrences = generated.occurrences;

  useEffect(() => {
    if (editing || loading || offline || !classId || generated.error) {
      setQuote(null);
      setQuoteError(generated.error);
      setQuoteLoading(false);
      return;
    }
    const currentRequest = requestId.value + 1;
    requestId.value = currentRequest;
    setQuoteLoading(true);
    setQuoteError(null);
    const timer = window.setTimeout(() => {
      void quoteBooking(classId, room, occurrences).then((result) => {
        if (requestId.value !== currentRequest) return;
        setQuote(result);
      }).catch((reason) => {
        if (requestId.value !== currentRequest) return;
        setQuote(null);
        setQuoteError(isConflict(reason) ? 'Едно или повече занимания съвпадат с друга резервация в графика.' : 'Не може да бъде получена ценова оферта.');
      }).finally(() => {
        if (requestId.value === currentRequest) setQuoteLoading(false);
      });
    }, QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [classId, editing, generated.error, loading, offline, occurrences, quoteBooking, requestId, room]);

  const quoteInvalid = !quote || quote.occurrences.length !== occurrences.length ||
    quote.occurrences.some((item) => item.amount === null || item.conflicts.length > 0) ||
    quote.total_amount === null;
  const confirmDisabled = editing
    ? pending || offline || !classId
    : pending || offline || loading || !classId || Boolean(generated.error) || quoteLoading || quoteInvalid;
  const noClasses = !editing && !loading && availableClasses.length === 0 && !error;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editing) {
      if (!existingBooking || !editBooking || pending) return;
      setPending(true); setError(null); setSuccess(null);
      try {
        const updated = await editBooking(
          existingBooking.id,
          existingBooking.version,
          classId || existingBooking.classId,
          room,
          localTime(date, minutes(startTime)),
          localTime(date, minutes(endTime)),
          existingBooking.studentDetails ?? null,
        );
        let refreshed: DaySchedule | undefined;
        let failed = false;
        if (onRefresh) {
          try { const result = await onRefresh(); if (result && 'bookings' in result) refreshed = result; }
          catch { failed = true; }
        }
        onDone(updated, refreshed, failed);
      } catch (reason) {
        setError(/stale_booking|PT409|version/i.test(errorText(reason))
          ? 'Тази резервация е променена другаде. Обновете графика и я проверете, преди да опитате отново.'
          : /booking_forbidden|insufficient_privilege/i.test(errorText(reason))
            ? 'Нямате право да променяте тази резервация.'
            : 'Резервацията не може да бъде променена. Опитайте отново.');
      }
      finally { setPending(false); }
      return;
    }
    if (confirmDisabled || !quote) return;
    setPending(true); setError(null); setSuccess(null); setRefreshFailed(false);
    try {
      const result = await createBookingSeries(classId, room, studentDetails.trim() || null, occurrences);
      const total = createdTotal(result);
      if (result.bookings.length !== occurrences.length || !total || result.bookings.some((item) => item.amount === null)) {
        throw new Error('invalid_create_response');
      }
      let refreshed: DaySchedule | undefined;
      let failed = false;
      if (onRefresh) {
        try { const value = await onRefresh(); if (value && 'bookings' in value) refreshed = value; }
        catch { failed = true; }
      }
      setRefreshFailed(failed);
      const createdMessage = result.bookings.length === 1
        ? 'Създадена е 1 резервация.'
        : `Създадени са ${result.bookings.length} резервации.`;
      setSuccess(`${createdMessage} Общо: ${money(total)}${failed ? ' Графикът не можа да бъде обновен.' : ''}`);
      onDone(undefined, refreshed, failed);
    } catch (reason) {
      setError(isConflict(reason) ? 'Тази резервация съвпада с друга в графика.' : 'Резервациите не могат да бъдат създадени. Опитайте отново.');
    } finally { setPending(false); }
  };

  const toggleWeekday = (value: number) => {
    setWeekdays((current) => current.includes(value) ? current.filter((day) => day !== value) : [...current, value].sort((a, b) => a - b));
  };

  return (
    <section className="booking-form" aria-labelledby="booking-form-title">
      <header>
        <h2 id="booking-form-title">{editing ? 'Промяна на резервация' : 'Резервиране на зала'}</h2>
        {editing && <p>Променяте само това занимание.</p>}
      </header>
      {error && <p className="booking-form__message booking-form__message--error" role="alert">{error}</p>}
      {success && <p className="booking-form__message booking-form__message--success" role="status">{success}</p>}
      {loading && <p role="status">Активните занимания се зареждат…</p>}
      {noClasses && <p className="booking-form__message" role="status">Създайте активно занимание, преди да резервирате зала.</p>}
      {offline && <p className="booking-form__message booking-form__message--offline" role="alert">Няма връзка с интернет. Промените по резервациите са изключени до възстановяване на връзката.</p>}
      {!loading && !noClasses && (
        <form onSubmit={handleSubmit}>
          {editing && existingBooking && (
            <dl className="booking-form__identity" aria-label="Информация за резервацията">
              <div><dt>Учител</dt><dd>{existingBooking.teacherName}</dd></div>
              <div><dt>Модул</dt><dd>{editingSeriesLabel ?? 'Избрано занимание от модула'}</dd></div>
            </dl>
          )}
          {profile?.role === 'admin' && !editing && (
            <>
              <label htmlFor="booking-teacher">Учител</label>
              <select id="booking-teacher" value={teacherId} onChange={(event) => setTeacherId(event.target.value)} disabled={pending || offline || editing}>
                {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
              </select>
            </>
          )}
          <label htmlFor="booking-class">Занимание</label>
          <select id="booking-class" value={classId} onChange={(event) => setClassId(event.target.value)} disabled={pending || offline}>
            {availableClasses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {!editing && (
            <>
              <fieldset className="booking-form__mode">
                <legend>Повтаряемост</legend>
                <label><input type="radio" name="booking-mode" value="one-off" checked={mode === 'one-off'} onChange={() => setMode('one-off')} disabled={pending || offline} /> Еднократно</label>
                <label><input type="radio" name="booking-mode" value="recurring" checked={mode === 'recurring'} onChange={() => setMode('recurring')} disabled={pending || offline} /> Повтарящо се</label>
              </fieldset>
              <label htmlFor="booking-date">{mode === 'recurring' ? 'Начална седмица (понеделник)' : 'Дата на резервацията'}</label>
              <input id="booking-date" type="date" min={mode === 'recurring' ? mondayOf(minimumDate) : minimumDate} value={mode === 'recurring' ? weekStart : date} onChange={(event) => { const minimumAllowed = mode === 'recurring' ? mondayOf(minimumDate) : minimumDate; const nextDate = event.target.value < minimumAllowed ? minimumAllowed : event.target.value; setDate(nextDate); setWeekStart(mondayOf(nextDate)); }} disabled={pending || offline} required />
              {mode === 'recurring' && (
                <>
                  <fieldset className="booking-form__weekdays">
                    <legend>Дни от седмицата</legend>
                    {WEEKDAYS.map((day) => <label key={day.value}><input type="checkbox" checked={weekdays.includes(day.value)} onChange={() => toggleWeekday(day.value)} disabled={pending || offline} /> {day.label}</label>)}
                  </fieldset>
                  <label htmlFor="booking-weeks">Брой седмици</label>
                  <input id="booking-weeks" type="number" min={1} max={52} step={1} value={weeks} onChange={(event) => setWeeks(event.target.value)} disabled={pending || offline} required />
                </>
              )}
            </>
          )}
          <label htmlFor="booking-start">Начален час</label>
          <select id="booking-start" value={startTime} onChange={(event) => setStartTime(event.target.value)} disabled={pending || offline} required>
            {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
          </select>
          <label htmlFor="booking-end">Краен час</label>
          <select id="booking-end" value={endTime} onChange={(event) => setEndTime(event.target.value)} disabled={pending || offline} required>
            {timeOptions.map((time) => <option key={time} value={time}>{time}</option>)}
          </select>
          <label htmlFor="booking-room">Зала</label>
          <select id="booking-room" value={room} onChange={(event) => setRoom(event.target.value as Room)} disabled={pending || offline}>
            {ROOMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          {!editing && <>
            <label htmlFor="booking-student-details">Поверителни бележки за ученика (по избор)</label>
            <textarea id="booking-student-details" maxLength={1000} value={studentDetails} onChange={(event) => setStudentDetails(event.target.value)} disabled={pending || offline} />
          </>}
          {!editing && (
            <section className="booking-form__quote" aria-live="polite" aria-label="Ценова оферта от сървъра">
              <h3>Преглед на цената</h3>
              {quoteLoading && <p role="status">Изчислява се ценова оферта…</p>}
              {!quoteLoading && quoteError && <p className="booking-form__message booking-form__message--error" role="alert">{quoteError}</p>}
              {!quoteLoading && !quoteError && generated.error && <p className="booking-form__message booking-form__message--error" role="alert">{generated.error}</p>}
              {!quoteLoading && !quoteError && !generated.error && quote && (
                <>
                  <p>{quote.occurrences.length} {quote.occurrences.length === 1 ? 'конкретно занимание' : 'конкретни занимания'}</p>
                  <ul className="booking-form__occurrences">
                    {quote.occurrences.map((occurrence) => <li key={`${occurrence.occurrence_index}:${occurrence.starts_at}`}>
                      <strong>{occurrence.starts_at.slice(0, 10)} {displayTime(occurrence.starts_at)}–{displayTime(occurrence.ends_at)}</strong>
                      <span>{occurrence.duration_minutes} минути · {money(occurrence.amount)}</span>
                      {occurrence.segments.length > 0 && <ul>{occurrence.segments.map((segment) => <li key={`${segment.starts_at}:${segment.ends_at}`}>{displayTime(segment.starts_at)}–{displayTime(segment.ends_at)} · {segment.label} · {money(segment.hourly_rate)}/ч · {money(segment.subtotal)}</li>)}</ul>}
                      {occurrence.conflicts.length > 0 && <span role="alert">Това занимание съвпада с друга резервация.</span>}
                    </li>)}
                  </ul>
                  <p className="booking-form__total"><strong>Общо: {money(quote.total_amount)}</strong></p>
                  {quoteInvalid && <p className="booking-form__message booking-form__message--error" role="alert">Преди потвърждение е необходима пълна ценова оферта без конфликти.</p>}
                </>
              )}
            </section>
          )}
          <div className="booking-form__actions">
            <button type="submit" disabled={confirmDisabled}>{pending ? 'Запазване…' : 'Запази'}</button>
            <button type="button" onClick={() => onCancel ? onCancel() : onDone()} disabled={pending}>Отказ</button>
          </div>
        </form>
      )}
    </section>
  );
}
