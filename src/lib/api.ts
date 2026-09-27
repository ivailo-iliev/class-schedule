import type { PostgrestError } from '@supabase/supabase-js';
import { daySlots, minutesOf } from './calendar';
import { getSupabaseClient, clearSession, isSessionRevokedError } from './session';
import type { Database, Json, Tables, TablesInsert } from './database.types';
import type {
  Booking,
  BookingDetail,
  BookingOccurrence,
  BookingQuote,
  CancelScope,
  CancellationResult,
  ClassItem,
  CreatedBooking,
  CreatedBookingSeries,
  DaySchedule,
  WeekSchedule,
  AdminMonthReport,
  AdminTeacherMonthReport,
  MonthReportRow,
  MyMonthReport,
  Profile,
  Room,
  SlotPrice,
} from './types';

type SupabaseResult<T> = { data: T | null; error: PostgrestError | null };
type ScheduleBookingPayload = {
  id: string;
  room: Room;
  starts_at: string;
  ends_at: string;
  teacher_name: string;
  activity_title: string;
  can_manage: boolean;
};
type DayPayload = {
  date: string;
  bookings: ScheduleBookingPayload[];
  slot_prices?: unknown[];
};
type WeekPayload = {
  week_start: string;
  week_end: string;
  days: Array<DayPayload>;
};
type ClassRow = Pick<Tables<'classes'>, 'id' | 'teacher_id' | 'name' | 'active'>;
type TeacherProfileRow = Pick<Tables<'profiles'>, 'id' | 'name' | 'role'>;

type BookingDetailPayload = {
  id: string;
  series_id: string;
  series_index: number;
  teacher_id: string;
  teacher_name: string;
  class_id: string;
  activity_title: string;
  room: Room;
  starts_at: string;
  ends_at: string;
  student_details: string | null;
  currency: string;
  amount: string | null;
  segments: BookingDetail['segments'];
  cancelled_at: string | null;
  cancelled_by: string | null;
  version: number;
  can_manage: boolean;
  has_future_active?: boolean;
  series_total?: number;
};

type MutationBookingPayload = Pick<BookingDetailPayload,
  'id' | 'class_id' | 'teacher_id' | 'room' | 'starts_at' | 'ends_at' |
  'cancelled_at' | 'cancelled_by' | 'version'>;

type MonthReportRowPayload = {
  id: string;
  teacher_id: string;
  teacher_name: string;
  class_id: string;
  activity_title: string;
  booking_date: string;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  room: Room;
  currency: string;
  calculated_amount: string;
  price_breakdown: MonthReportRow['priceBreakdown'];
  cancelled_at: string | null;
  cancelled: boolean;
  effective_amount_due: string;
};
type MyMonthReportPayload = {
  month: string;
  teacher_id: string;
  teacher_name: string;
  reservation_count: number;
  cancelled_count: number;
  total_due: string;
  rows: MonthReportRowPayload[];
};
type AdminTeacherMonthReportPayload = Omit<MyMonthReportPayload, 'month'>;
type AdminMonthReportPayload = {
  month: string;
  teacher_id: string | null;
  teachers: AdminTeacherMonthReportPayload[];
  cashbox_total: string;
};

function client() { return getSupabaseClient(); }
function monthDate(month: string): string {
  return /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month;
}
async function fetchOr<T>(operation: () => PromiseLike<SupabaseResult<T>>): Promise<T> {
  const result = await operation();
  if (result.error) { if (isSessionRevokedError(result.error)) await clearSession(); throw result.error; }
  if (result.data === null) throw new Error('empty_response');
  return result.data;
}
function mapScheduleBooking(row: DayPayload['bookings'][number]): Booking {
  return { id: row.id, classId: '', teacherId: '', className: row.activity_title, teacherName: row.teacher_name,
    room: row.room, startsAt: row.starts_at, endsAt: row.ends_at, hour: Math.floor(minutesOf(row.starts_at) / 60),
    cancelledAt: null, version: 0, canEdit: row.can_manage };
}

function mapSlotPrice(row: unknown): SlotPrice | null {
  if (!row || typeof row !== 'object') return null;
  const value = row as { starts_at?: unknown; price?: unknown; currency?: unknown };
  if (typeof value.starts_at !== 'string' || typeof value.price !== 'string' || value.price.trim() === '' || typeof value.currency !== 'string') return null;
  return { startsAt: value.starts_at, price: value.price, currency: value.currency };
}

function isIsoDate(value: unknown): value is string {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isScheduleBooking(value: unknown): value is ScheduleBookingPayload {
  if (!value || typeof value !== 'object') return false;
  const booking = value as Partial<ScheduleBookingPayload>;
  return typeof booking.id === 'string'
    && (booking.room === 'hall' || booking.room === 'room')
    && typeof booking.starts_at === 'string'
    && typeof booking.ends_at === 'string'
    && typeof booking.teacher_name === 'string'
    && typeof booking.activity_title === 'string'
    && typeof booking.can_manage === 'boolean';
}

function isWeekPayload(value: unknown, requestedDate: string): value is WeekPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<WeekPayload>;
  if (!isIsoDate(payload.week_start) || !isIsoDate(payload.week_end)) return false;
  const weekStart = payload.week_start;
  const weekEnd = payload.week_end;
  const weekStartDay = new Date(`${weekStart}T00:00:00Z`).getUTCDay();
  const weekEndDay = new Date(`${weekEnd}T00:00:00Z`).getUTCDay();
  if (weekStartDay !== 1 || weekEndDay !== 0 || weekEnd !== addDays(weekStart, 6)) return false;
  if (!isIsoDate(requestedDate) || requestedDate < weekStart || requestedDate > weekEnd) return false;
  if (!Array.isArray(payload.days) || payload.days.length !== 7) return false;
  return payload.days.every((day, index) => (
    !!day
    && isIsoDate(day.date)
    && day.date === addDays(weekStart, index)
    && Array.isArray(day.bookings)
    && day.bookings.every(isScheduleBooking)
    && (day.slot_prices === undefined || Array.isArray(day.slot_prices))
  ));
}

function mapWeekSchedule(payload: WeekPayload): WeekSchedule {
  const days = payload.days.map((day) => ({
    date: day.date,
    slots: daySlots(day.date),
    bookings: day.bookings.map(mapScheduleBooking),
    slotPrices: (day.slot_prices ?? [])
      .map(mapSlotPrice)
      .filter((price): price is SlotPrice => price !== null),
  }));
  return {
    weekStart: payload.week_start,
    weekEnd: payload.week_end,
    days: days as WeekSchedule['days'],
  };
}

function mapBookingDetail(row: BookingDetailPayload): BookingDetail {
  const seriesTotal = typeof row.series_total === 'number' && Number.isInteger(row.series_total) && row.series_total > 0
    ? row.series_total
    : row.series_index + 1;
  return {
    id: row.id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    className: row.activity_title,
    teacherName: row.teacher_name,
    room: row.room,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    hour: Math.floor(minutesOf(row.starts_at) / 60),
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    version: row.version,
    canEdit: row.can_manage && row.cancelled_at === null,
    seriesId: row.series_id,
    seriesIndex: row.series_index,
    seriesTotal,
    studentDetails: row.student_details,
    currency: row.currency,
    amount: row.amount,
    segments: Array.isArray(row.segments) ? row.segments : [],
    hasFutureActive: row.has_future_active === true,
  };
}

function mapMutationBooking(row: MutationBookingPayload): Booking {
  return {
    id: row.id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    className: '',
    teacherName: '',
    room: row.room,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    hour: Math.floor(minutesOf(row.starts_at) / 60),
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    version: row.version,
    canEdit: row.cancelled_at === null,
  };
}

function mapMonthReportRow(row: MonthReportRowPayload): MonthReportRow {
  return {
    id: row.id,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    classId: row.class_id,
    activityTitle: row.activity_title,
    bookingDate: row.booking_date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    durationMinutes: row.duration_minutes,
    room: row.room,
    currency: row.currency,
    calculatedAmount: row.calculated_amount,
    priceBreakdown: Array.isArray(row.price_breakdown) ? row.price_breakdown : [],
    cancelledAt: row.cancelled_at,
    cancelled: row.cancelled,
    effectiveAmountDue: row.effective_amount_due,
  };
}

export async function getWeek(date: string): Promise<WeekSchedule> {
  const result = await fetchOr(() => client().rpc('get_week', { p_date: date }) as unknown as PromiseLike<SupabaseResult<unknown>>);
  if (!isWeekPayload(result, date)) throw new Error('invalid_week_response');
  return mapWeekSchedule(result);
}

// Temporary compatibility for the existing Schedule caller; remove once it uses getWeek.
export async function getDay(date: string): Promise<DaySchedule> {
  const week = await getWeek(date);
  const day = week.days.find((candidate) => candidate.date === date);
  if (!day) throw new Error('invalid_day_response');
  return day;
}

export async function getMyClasses(): Promise<ClassItem[]> {
  const rows = await fetchOr(() => client().from('classes').select('id, teacher_id, name, active').order('name') as unknown as PromiseLike<SupabaseResult<ClassRow[]>>);
  return rows.map((row) => ({ id: row.id, teacherId: row.teacher_id, name: row.name, active: row.active }));
}
export async function getTeachers(): Promise<Profile[]> {
  const rows = await fetchOr(() => client().from('profiles').select('id, name, role, active').eq('role', 'teacher').eq('active', true).order('name') as unknown as PromiseLike<SupabaseResult<TeacherProfileRow[]>>);
  return rows.map(({ id, name, role }) => ({ id, name, role }));
}
export async function createClass(name: string, teacherId?: string): Promise<ClassItem> {
  const payload = (teacherId ? { name: name.trim(), teacher_id: teacherId } : { name: name.trim() }) as TablesInsert<'classes'>;
  const row = await fetchOr(() => client().from('classes').insert(payload).select('id, teacher_id, name, active').single() as unknown as PromiseLike<SupabaseResult<ClassRow>>);
  return { id: row.id, teacherId: row.teacher_id, name: row.name, active: row.active };
}
export async function updateClass(id: string, changes: Partial<Pick<ClassItem, 'name' | 'active'>>): Promise<ClassItem> {
  const row = await fetchOr(() => client().from('classes').update({ ...(changes.name === undefined ? {} : { name: changes.name.trim() }), ...(changes.active === undefined ? {} : { active: changes.active }) }).eq('id', id).select('id, teacher_id, name, active').single() as unknown as PromiseLike<SupabaseResult<ClassRow>>);
  return { id: row.id, teacherId: row.teacher_id, name: row.name, active: row.active };
}

export async function quoteBooking(
  classId: string,
  room: Room,
  occurrences: BookingOccurrence[],
  excludeBookingId?: string,
): Promise<BookingQuote> {
  return fetchOr(() => client().rpc('quote_booking', {
    p_class_id: classId,
    p_room: room,
    p_occurrences: occurrences as unknown as Json,
    ...(excludeBookingId ? { p_exclude_booking_id: excludeBookingId } : {}),
  }) as unknown as PromiseLike<SupabaseResult<BookingQuote>>);
}

function totalFromCreated(bookings: CreatedBooking[]): string {
  return bookings.reduce((total, booking) => total + Number(booking.amount ?? Number.NaN), 0)
    .toFixed(2);
}

export async function createBookingSeries(
  classId: string,
  room: Room,
  studentDetails: string | null,
  occurrences: BookingOccurrence[],
): Promise<CreatedBookingSeries> {
  const result = await fetchOr(() => client().rpc('create_booking_series', {
    p_class_id: classId,
    p_room: room,
    p_student_details: studentDetails as unknown as string,
    p_occurrences: occurrences as unknown as Json,
  }) as unknown as PromiseLike<SupabaseResult<CreatedBookingSeries>>);
  return {
    ...result,
    total_amount: result.total_amount || totalFromCreated(result.bookings),
  };
}

export async function getBookingDetails(id: string): Promise<BookingDetail> {
  const result = await fetchOr(() => client().rpc('get_booking_details', {
    p_id: id,
  }) as unknown as PromiseLike<SupabaseResult<BookingDetailPayload>>);
  return mapBookingDetail(result);
}

export async function editBooking(
  id: string,
  expectedVersion: number,
  classId: string,
  room: Room,
  startsAt: string,
  endsAt: string,
  studentDetails: string | null,
): Promise<Booking> {
  const result = await fetchOr(() => client().rpc('edit_booking', {
    p_id: id,
    p_expected_version: expectedVersion,
    p_class_id: classId,
    p_room: room,
    p_starts_at: startsAt,
    p_ends_at: endsAt,
    p_student_details: studentDetails as unknown as string,
  }) as unknown as PromiseLike<SupabaseResult<MutationBookingPayload>>);
  return mapMutationBooking(result);
}

export async function cancelBooking(
  id: string,
  expectedVersion: number,
  scope: CancelScope,
): Promise<CancellationResult> {
  const result = await fetchOr(() => client().rpc('cancel_booking', {
    p_id: id,
    p_expected_version: expectedVersion,
    p_scope: scope,
  }) as unknown as PromiseLike<SupabaseResult<{ bookings: MutationBookingPayload[]; cancelled_count: number }>>);
  return {
    bookings: (result.bookings ?? []).map(mapMutationBooking),
    cancelledCount: result.cancelled_count,
  };
}

export async function getMyMonthReport(month: string): Promise<MyMonthReport> {
  const result = await fetchOr(() => client().rpc('get_my_month_report', {
    p_month: monthDate(month),
  }) as unknown as PromiseLike<SupabaseResult<MyMonthReportPayload>>);
  return {
    month: result.month,
    teacherId: result.teacher_id,
    teacherName: result.teacher_name,
    reservationCount: result.reservation_count,
    cancelledCount: result.cancelled_count,
    totalDue: result.total_due,
    rows: result.rows.map(mapMonthReportRow),
  };
}

export async function getAdminMonthReport(month: string, teacherId: string | null = null): Promise<AdminMonthReport> {
  const result = await fetchOr(() => client().rpc('get_admin_month_report', {
    p_month: monthDate(month),
    p_teacher_id: teacherId,
  }) as unknown as PromiseLike<SupabaseResult<AdminMonthReportPayload>>);
  const teachers: AdminTeacherMonthReport[] = result.teachers.map((teacher) => ({
    teacherId: teacher.teacher_id,
    teacherName: teacher.teacher_name,
    reservationCount: teacher.reservation_count,
    cancelledCount: teacher.cancelled_count,
    totalDue: teacher.total_due,
    rows: teacher.rows.map(mapMonthReportRow),
  }));
  return {
    month: result.month,
    teacherId: result.teacher_id,
    teachers,
    cashboxTotal: result.cashbox_total,
  };
}
