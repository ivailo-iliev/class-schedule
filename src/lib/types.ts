import type { Session } from '@supabase/supabase-js';

export type Room = 'hall' | 'room';
export type Role = 'teacher' | 'admin';

export interface Slot { startsAt: string; }
export interface ClassItem { id: string; teacherId: string; name: string; active: boolean; }
export interface Booking {
  id: string;
  classId: string;
  teacherId: string;
  className: string;
  teacherName: string;
  room: Room;
  startsAt: string;
  endsAt: string;
  hour: number;
  cancelledAt: string | null;
  cancelledBy?: string | null;
  studentDetails?: string | null;
  version: number;
  canEdit: boolean;
}
export interface DaySchedule { date: string; slots: Slot[]; bookings: Booking[]; }
export interface Profile { id: string; name: string; role: Role; }

export interface BookingDetail extends Booking {
  seriesId: string;
  seriesIndex: number;
  studentDetails: string | null;
  currency: string;
  amount: string | null;
  segments: PriceSegment[];
  hasFutureActive: boolean;
}

export type CancelScope = 'one' | 'future';
export interface CancellationResult {
  bookings: BookingDetail[];
  cancelledCount: number;
}

export interface BookingOccurrence {
  starts_at: string;
  ends_at: string;
}
export interface PriceSegment {
  starts_at: string;
  ends_at: string;
  rule_id: string | null;
  label: string;
  hourly_rate: string;
  subtotal: string;
}
export interface QuoteConflict {
  date: string;
  room: Room;
}
export interface QuotedOccurrence extends BookingOccurrence {
  occurrence_index: number;
  duration_minutes: number;
  amount: string | null;
  segments: PriceSegment[];
  conflicts: QuoteConflict[];
}
export interface BookingQuote {
  occurrences: QuotedOccurrence[];
  total_amount: string | null;
}
export interface CreatedBooking {
  id: string;
  series_id: string;
  series_index: number;
  teacher_id: string;
  class_id: string;
  room: Room;
  starts_at: string;
  ends_at: string;
  student_details: string | null;
  currency: string;
  amount: string | null;
  segments: PriceSegment[];
  cancelled_at: string | null;
  cancelled_by: string | null;
  version: number;
}
export interface CreatedBookingSeries {
  series_id: string;
  bookings: CreatedBooking[];
  total_amount: string;
}

export interface NativeSessionResponse {
  access_token: string; refresh_token: string; expires_in?: number; expires_at?: number;
  user?: Session['user']; profile: Profile;
}
export type ExchangeResponse = NativeSessionResponse;
