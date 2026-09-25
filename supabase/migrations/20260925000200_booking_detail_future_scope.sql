-- Expose only the authorized future-scope fact needed by the details UI.
create or replace function public.get_booking_details(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  booking_row public.bookings%rowtype;
  class_name text;
  teacher_name text;
  has_future_active boolean;
begin
  if private.actor_id() is null then
    raise insufficient_privilege using message = 'active_profile_required';
  end if;
  if p_id is null then
    raise sqlstate 'PT422' using message = 'invalid_booking_id';
  end if;
  select * into booking_row from public.bookings where id = p_id;
  if not found then
    raise sqlstate 'PT404' using message = 'booking_not_found';
  end if;
  if not private.can_manage(booking_row.teacher_id) then
    raise insufficient_privilege using message = 'booking_forbidden';
  end if;
  select c.name, p.name into class_name, teacher_name
  from public.classes c join public.profiles p on p.id = booking_row.teacher_id
  where c.id = booking_row.class_id;
  select exists (
    select 1 from public.bookings later
    where later.series_id = booking_row.series_id
      and later.series_index > booking_row.series_index
      and later.cancelled_at is null
  ) into has_future_active;
  return jsonb_build_object(
    'id', booking_row.id,
    'series_id', booking_row.series_id,
    'series_index', booking_row.series_index,
    'teacher_id', booking_row.teacher_id,
    'teacher_name', teacher_name,
    'class_id', booking_row.class_id,
    'activity_title', class_name,
    'room', booking_row.room,
    'starts_at', to_char(booking_row.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'ends_at', to_char(booking_row.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'student_details', booking_row.student_details,
    'currency', booking_row.currency,
    'amount', to_char(booking_row.calculated_amount, 'FM9999999990.00'),
    'segments', booking_row.price_breakdown,
    'cancelled_at', booking_row.cancelled_at,
    'cancelled_by', booking_row.cancelled_by,
    'version', booking_row.version,
    'can_manage', true,
    'has_future_active', has_future_active
  );
end;
$$;

revoke all on function public.get_booking_details(uuid) from public, anon;
grant execute on function public.get_booking_details(uuid) to authenticated;
