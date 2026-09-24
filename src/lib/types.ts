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
  version: number;
  canEdit: boolean;
}
export interface DaySchedule { date: string; slots: Slot[]; bookings: Booking[]; }
export interface Profile { id: string; name: string; role: Role; }
export interface NativeSessionResponse {
  access_token: string; refresh_token: string; expires_in?: number; expires_at?: number;
  user?: Session['user']; profile: Profile;
}
export type ExchangeResponse = NativeSessionResponse;
