-- Add the logged-in teacher's half-hour prices to the safe daily schedule projection.
-- Missing or ambiguous pricing must not make the schedule unreadable.
create or replace function public.get_day(p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  schedule jsonb;
  actor uuid := private.actor_id();
  slot_prices jsonb := '[]'::jsonb;
  slot_start timestamp without time zone;
  priced jsonb;
begin
  if actor is null then
    raise insufficient_privilege using message = 'active_profile_required';
  end if;
  if p_date is null or not isfinite(p_date) then
    raise sqlstate 'PT422' using message = 'invalid_date';
  end if;

  for slot_start in
    select generate_series(
      p_date::timestamp + interval '8 hours 30 minutes',
      p_date::timestamp + interval '19 hours 30 minutes',
      interval '30 minutes'
    )::timestamp
  loop
    begin
      priced := private.price_occurrence(actor, slot_start, slot_start + interval '30 minutes');
      slot_prices := slot_prices || jsonb_build_array(jsonb_build_object(
        'starts_at', to_char(slot_start, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'price', priced ->> 'amount',
        'currency', 'EUR'
      ));
    exception when sqlstate 'PT422' then
      null;
    end;
  end loop;

  select jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'bookings', coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id,
      'room', b.room,
      'starts_at', to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_at', to_char(b.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'teacher_name', p.name,
      'activity_title', c.name,
      'can_manage', private.can_manage(b.teacher_id)
    ) order by b.starts_at, b.room, b.id), '[]'::jsonb),
    'slot_prices', slot_prices
  ) into schedule
  from public.bookings b
  join public.classes c on c.id = b.class_id
  join public.profiles p on p.id = b.teacher_id
  where b.starts_at::date = p_date and b.cancelled_at is null;

  return schedule;
end;
$$;