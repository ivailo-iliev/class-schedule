-- Replace the public daily schedule read surface with one safe weekly projection.
-- Missing or ambiguous pricing must not make any day in the schedule unreadable.
create function public.get_week(p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  actor uuid := private.actor_id();
  week_start date;
  week_end date;
  slot_start timestamp without time zone;
  priced jsonb;
  prices_by_day jsonb := '{}'::jsonb;
  schedule jsonb;
begin
  if actor is null then
    raise insufficient_privilege using message = 'active_profile_required';
  end if;
  if p_date is null or not isfinite(p_date) then
    raise sqlstate 'PT422' using message = 'invalid_date';
  end if;

  week_start := p_date - (extract(isodow from p_date)::integer - 1);
  week_end := week_start + 6;

  -- Generate all seven days' slots here. Pricing configuration failures are
  -- intentionally localized to their individual slot, as in the old daily RPC.
  for slot_start in
    select day_start + interval '8 hours 30 minutes' + slot_index * interval '30 minutes'
    from generate_series(
      week_start::timestamp,
      week_end::timestamp,
      interval '1 day'
    ) as day_start
    cross join generate_series(0, 22) as slot_index
    order by day_start, slot_index
  loop
    begin
      priced := private.price_occurrence(actor, slot_start, slot_start + interval '30 minutes');
      prices_by_day := jsonb_set(
        prices_by_day,
        array[to_char(slot_start, 'YYYY-MM-DD')],
        coalesce(prices_by_day -> to_char(slot_start, 'YYYY-MM-DD'), '[]'::jsonb) ||
          jsonb_build_array(jsonb_build_object(
            'starts_at', to_char(slot_start, 'YYYY-MM-DD"T"HH24:MI:SS'),
            'price', priced ->> 'amount',
            'currency', 'EUR'
          ))
      );
    exception when sqlstate 'PT422' then
      null;
    end;
  end loop;

  -- This is one set-based booking query for the whole week; the days CTE keeps
  -- the empty dates in the serialized result.
  with days as (
    select generate_series(week_start, week_end, interval '1 day')::date as date
  ), bookings_by_day as (
    select b.starts_at::date as date,
      jsonb_agg(jsonb_build_object(
        'id', b.id,
        'room', b.room,
        'starts_at', to_char(b.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'ends_at', to_char(b.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'teacher_name', p.name,
        'activity_title', c.name,
        'can_manage', private.can_manage(b.teacher_id)
      ) order by b.starts_at, b.room, b.id) as bookings
    from public.bookings b
    join public.classes c on c.id = b.class_id
    join public.profiles p on p.id = b.teacher_id
    where b.starts_at >= week_start::timestamp
      and b.starts_at < (week_start + 7)::timestamp
      and b.cancelled_at is null
    group by b.starts_at::date
  )
  select jsonb_build_object(
    'week_start', to_char(week_start, 'YYYY-MM-DD'),
    'week_end', to_char(week_end, 'YYYY-MM-DD'),
    'days', jsonb_agg(jsonb_build_object(
      'date', to_char(days.date, 'YYYY-MM-DD'),
      'bookings', coalesce(bookings_by_day.bookings, '[]'::jsonb),
      'slot_prices', coalesce(prices_by_day -> to_char(days.date, 'YYYY-MM-DD'), '[]'::jsonb)
    ) order by days.date)
  ) into schedule
  from days
  left join bookings_by_day using (date);

  return schedule;
end;
$$;

revoke all on function public.get_week(date) from public, anon;
grant execute on function public.get_week(date) to authenticated;

drop function public.get_day(date);
