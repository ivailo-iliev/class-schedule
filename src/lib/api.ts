import type { PostgrestError } from '@supabase/supabase-js';
import { dayBounds, daySlots, localHourOf } from './calendar';
import { getProfile, getSupabaseClient, clearSession, isSessionRevokedError } from './session';
import type { Database, Tables, TablesInsert } from './database.types';
import type { Booking, ClassItem, DaySchedule, Profile, Room } from './types';

type BookingRow = Pick<Tables<'bookings'>, 'id' | 'class_id' | 'room' | 'starts_at' | 'cancelled_at' | 'version'> & {
  classes: Pick<Tables<'classes'>, 'id' | 'name' | 'teacher_id'> | null;
};
type ProfileRow = Pick<Tables<'profiles'>, 'id' | 'name'>;
type TeacherProfileRow = Pick<Tables<'profiles'>, 'id' | 'name' | 'role'>;
type ClassRow = Pick<Tables<'classes'>, 'id' | 'teacher_id' | 'name' | 'active'>;
type SupabaseResult<T> = { data: T | null; error: PostgrestError | null };

function client() {
  return getSupabaseClient();
}

async function fetchOr<T>(operation: () => PromiseLike<SupabaseResult<T>>): Promise<T> {
  const result = await operation();
  if (result.error) {
    if (isSessionRevokedError(result.error)) await clearSession();
    throw result.error;
  }
  if (result.data === null) throw new Error('empty_response');
  return result.data;
}

function mapClass(row: ClassRow): ClassItem {
  return { id: row.id, teacherId: row.teacher_id, name: row.name, active: row.active };
}

function mapBooking(row: BookingRow, teacherName: string, profile: Profile | null): Booking {
  if (!row.classes) throw new Error('booking_class_missing');
  return {
    id: row.id,
    classId: row.class_id,
    teacherId: row.classes.teacher_id,
    className: row.classes.name,
    teacherName,
    room: row.room,
    startsAt: row.starts_at,
    hour: localHourOf(row.starts_at),
    cancelledAt: row.cancelled_at,
    version: row.version,
    canEdit: Boolean(profile && row.cancelled_at === null &&
      (profile.role === 'admin' || profile.id === row.classes.teacher_id)),
  };
}

export async function getDay(date: string): Promise<DaySchedule> {
  const { start, end } = dayBounds(date);
  const rows = await fetchOr(() => client().from('bookings')
    .select('id, class_id, room, starts_at, cancelled_at, version, classes!inner(id, name, teacher_id)')
    .gte('starts_at', start.toISOString())
    .lt('starts_at', end.toISOString())
    .order('starts_at') as unknown as PromiseLike<SupabaseResult<BookingRow[]>>);

  const teacherIds = [...new Set(rows.flatMap((row) => row.classes ? [row.classes.teacher_id] : []))];
  const profiles = teacherIds.length === 0 ? [] : await fetchOr(() => client().from('profiles')
    .select('id, name')
    .in('id', teacherIds) as unknown as PromiseLike<SupabaseResult<ProfileRow[]>>);
  const teacherNames = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const profile = getProfile();
  return {
    date,
    slots: daySlots(date),
    bookings: rows.map((row) => mapBooking(row, row.classes ? (teacherNames.get(row.classes.teacher_id) ?? '') : '', profile)),
  };
}

export async function getMyClasses(): Promise<ClassItem[]> {
  const rows = await fetchOr(() => client().from('classes')
    .select('id, teacher_id, name, active')
    .order('name') as unknown as PromiseLike<SupabaseResult<ClassRow[]>>);
  return rows.map(mapClass);
}

export async function getTeachers(): Promise<Profile[]> {
  const rows = await fetchOr(() => client().from('profiles')
    .select('id, name, role, active')
    .eq('role', 'teacher')
    .eq('active', true)
    .order('name') as unknown as PromiseLike<SupabaseResult<TeacherProfileRow[]>>);
  return rows.map((row) => ({ id: row.id, name: row.name, role: row.role }));
}

export async function createClass(name: string, teacherId?: string): Promise<ClassItem> {
  const trimmed = name.trim();
  const payload = (teacherId ? { name: trimmed, teacher_id: teacherId } : { name: trimmed }) as TablesInsert<'classes'>;
  const row = await fetchOr(() => client().from('classes')
    .insert(payload)
    .select('id, teacher_id, name, active')
    .single() as unknown as PromiseLike<SupabaseResult<ClassRow>>);
  return mapClass(row);
}

export async function updateClass(
  id: string,
  changes: Partial<Pick<ClassItem, 'name' | 'active'>>,
): Promise<ClassItem> {
  const payload: Database['public']['Tables']['classes']['Update'] = {
    ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
    ...(changes.active === undefined ? {} : { active: changes.active }),
  };
  const row = await fetchOr(() => client().from('classes')
    .update(payload)
    .eq('id', id)
    .select('id, teacher_id, name, active')
    .single() as unknown as PromiseLike<SupabaseResult<ClassRow>>);
  return mapClass(row);
}

export async function scheduleBookings(
  classId: string,
  room: Room,
  firstDate: string,
  hour: number,
  occurrences = 1,
  weekday?: number,
): Promise<Booking[]> {
  const rows = await fetchOr(() => client().rpc('schedule_bookings', {
    p_class_id: classId,
    p_room: room,
    p_first_date: firstDate,
    p_hour: hour,
    p_occurrences: occurrences,
    ...(weekday === undefined ? {} : { p_weekday: weekday }),
  }) as unknown as PromiseLike<SupabaseResult<Tables<'bookings'>[]>>);
  return rows.map((row) => ({
    id: row.id,
    classId: row.class_id,
    teacherId: '',
    className: '',
    teacherName: '',
    room: row.room,
    startsAt: row.starts_at,
    hour: localHourOf(row.starts_at),
    cancelledAt: row.cancelled_at,
    version: row.version,
    canEdit: true,
  }));
}

export async function editBooking(
  id: string,
  expectedVersion: number,
  classId: string,
  room: Room,
  date: string,
  hour: number,
): Promise<Booking> {
  const row = await fetchOr(() => client().rpc('edit_booking', {
    p_id: id,
    p_expected_version: expectedVersion,
    p_class_id: classId,
    p_room: room,
    p_date: date,
    p_hour: hour,
  }).single() as unknown as PromiseLike<SupabaseResult<Tables<'bookings'>>>);
  return {
    id: row.id, classId: row.class_id, teacherId: '', className: '', teacherName: '',
    room: row.room, startsAt: row.starts_at, hour: localHourOf(row.starts_at),
    cancelledAt: row.cancelled_at, version: row.version, canEdit: true,
  };
}

export async function cancelBooking(id: string, expectedVersion: number): Promise<Booking> {
  const row = await fetchOr(() => client().rpc('cancel_booking', {
    p_id: id,
    p_expected_version: expectedVersion,
  }).single() as unknown as PromiseLike<SupabaseResult<Tables<'bookings'>>>);
  return {
    id: row.id, classId: row.class_id, teacherId: '', className: '', teacherName: '',
    room: row.room, startsAt: row.starts_at, hour: localHourOf(row.starts_at),
    cancelledAt: row.cancelled_at, version: row.version, canEdit: false,
  };
}
