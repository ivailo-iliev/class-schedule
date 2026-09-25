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
  AdminMonthReport,
  AdminTeacherMonthReport,
  MonthReportRow,
  MyMonthReport,
  Profile,
  Room,
} from './types';

type SupabaseResult<T> = { data: T | null; error: PostgrestError | null };
type DayPayload = { date: string; bookings: Array<{ id: string; room: Room; starts_at: string; ends_at: string; teacher_name: string; activity_title: string; can_manage: boolean }> };
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

function mapBookingDetail(row: BookingDetailPayload): BookingDetail {
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

export async function getDay(date: string): Promise<DaySchedule> {
  const result = await fetchOr(() => client().rpc('get_day', { p_date: date }) as unknown as PromiseLike<SupabaseResult<DayPayload>>);
  if (result.date !== date || !Array.isArray(result.bookings)) throw new Error('invalid_day_response');
  return { date, slots: daySlots(date), bookings: result.bookings.map(mapScheduleBooking) };
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
): Promise<BookingQuote> {
  return fetchOr(() => client().rpc('quote_booking', {
    p_class_id: classId,
    p_room: room,
    p_occurrences: occurrences as unknown as Json,
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
    p_month: month,
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
    p_month: month,
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
