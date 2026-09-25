import type { PostgrestError } from '@supabase/supabase-js';
import { daySlots, minutesOf } from './calendar';
import { getSupabaseClient, clearSession, isSessionRevokedError } from './session';
import type { Database, Json, Tables, TablesInsert } from './database.types';
import type {
  Booking,
  BookingOccurrence,
  BookingQuote,
  ClassItem,
  CreatedBooking,
  CreatedBookingSeries,
  DaySchedule,
  Profile,
  Room,
} from './types';

type SupabaseResult<T> = { data: T | null; error: PostgrestError | null };
type DayPayload = { date: string; bookings: Array<{ id: string; room: Room; starts_at: string; ends_at: string; teacher_name: string; activity_title: string; can_manage: boolean }> };
type ClassRow = Pick<Tables<'classes'>, 'id' | 'teacher_id' | 'name' | 'active'>;
type TeacherProfileRow = Pick<Tables<'profiles'>, 'id' | 'name' | 'role'>;

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

// Detail editing/cancellation is owned by the booking-details workstream. Keep
// the narrow exports so older callers fail closed instead of bypassing RPCs.
export async function editBooking(_id: string, _version: number, _classId: string, _room: Room, _date: string, _hour: number): Promise<Booking> {
  throw new Error('booking_mutation_ui_pending');
}
export async function cancelBooking(_id: string, _version: number): Promise<Booking> {
  throw new Error('booking_mutation_ui_pending');
}
