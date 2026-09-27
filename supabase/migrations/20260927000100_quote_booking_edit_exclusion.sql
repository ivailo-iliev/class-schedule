-- Editing an occurrence needs a display-only quote that omits that same row,
-- while creation retains the normal three-argument/default-exclusion behavior.
drop function public.quote_booking(uuid, public.room, jsonb);

create function public.quote_booking(
  p_class_id uuid,
  p_room public.room,
  p_occurrences jsonb,
  p_exclude_booking_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  class_row public.classes%rowtype;
  excluded_booking public.bookings%rowtype;
  occurrence record;
  priced jsonb;
  result jsonb := '[]'::jsonb;
  total numeric(12,2) := 0;
begin
  class_row := private.require_active_managed_class(p_class_id);
  if p_room is null then
    raise sqlstate 'PT422' using message = 'invalid_room';
  end if;

  if p_exclude_booking_id is not null then
    select * into excluded_booking
    from public.bookings
    where id = p_exclude_booking_id;
    if not found then
      raise sqlstate 'PT404' using message = 'booking_not_found';
    end if;
    if excluded_booking.cancelled_at is not null then
      raise sqlstate 'PT409' using message = 'cancelled_booking_read_only';
    end if;
    if not private.can_manage(excluded_booking.teacher_id) then
      raise insufficient_privilege using message = 'booking_forbidden';
    end if;
    if excluded_booking.teacher_id <> class_row.teacher_id then
      raise sqlstate 'PT422' using message = 'booking_teacher_immutable';
    end if;
  end if;

  for occurrence in select * from private.occurrence_rows(p_occurrences) loop
    priced := private.price_occurrence(class_row.teacher_id, occurrence.starts_at, occurrence.ends_at);
    total := total + (priced ->> 'amount')::numeric;
    result := result || jsonb_build_array(jsonb_build_object(
      'occurrence_index', occurrence.occurrence_index,
      'starts_at', to_char(occurrence.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_at', to_char(occurrence.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'duration_minutes', (extract(epoch from occurrence.ends_at - occurrence.starts_at) / 60)::integer,
      'amount', priced ->> 'amount',
      'segments', priced -> 'segments',
      'conflicts', private.booking_conflicts(
        class_row.teacher_id, p_room, occurrence.starts_at, occurrence.ends_at, p_exclude_booking_id
      )
    ));
  end loop;
  return jsonb_build_object(
    'occurrences', result,
    'total_amount', to_char(round(total, 2), 'FM9999999990.00')
  );
end;
$$;

revoke all on function public.quote_booking(uuid, public.room, jsonb, uuid) from public, anon;
grant execute on function public.quote_booking(uuid, public.room, jsonb, uuid) to authenticated;
