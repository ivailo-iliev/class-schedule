create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;
create schema private;

revoke all on schema private from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

create type public.app_role as enum ('admin', 'teacher');
create type public.room as enum ('hall', 'room');

create function private.valid_weekdays(p_weekdays smallint[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(p_weekdays) > 0
     and p_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
     and cardinality(p_weekdays) = cardinality(array(select distinct unnest(p_weekdays)))
$$;

create table public.profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  role public.app_role not null default 'teacher',
  active boolean not null default true,
  access_token_hash text unique check (access_token_hash ~ '^[0-9a-f]{64}$'),
  auth_user_id uuid unique,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create table public.classes (
  id uuid primary key default extensions.gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict
);
create index classes_teacher_idx on public.classes(teacher_id);

create table private.pricing_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  teacher_id uuid references public.profiles(id) on delete restrict,
  weekdays smallint[] not null,
  start_time time without time zone,
  end_time time without time zone,
  hourly_rate numeric(12,2) not null check (hourly_rate >= 0),
  priority integer not null default 0,
  label text not null check (label = btrim(label) and char_length(label) between 1 and 200),
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint pricing_rules_weekdays check (private.valid_weekdays(weekdays)),
  constraint pricing_rules_time_range check (
    (start_time is null and end_time is null)
    or (
      start_time is not null and end_time is not null and start_time < end_time
      and extract(second from start_time) = 0 and extract(second from end_time) = 0
      and extract(minute from start_time) in (0, 30)
      and extract(minute from end_time) in (0, 30)
    )
  )
);
create index pricing_rules_lookup_idx
  on private.pricing_rules(teacher_id, active, priority desc);

create table public.bookings (
  id uuid primary key default extensions.gen_random_uuid(),
  series_id uuid not null default extensions.gen_random_uuid(),
  series_index integer not null default 0 check (series_index >= 0),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  room public.room not null,
  starts_at timestamp without time zone not null,
  ends_at timestamp without time zone not null,
  student_details text check (
    student_details is null or (student_details = btrim(student_details) and char_length(student_details) <= 1000)
  ),
  currency text not null default 'EUR' check (currency = 'EUR'),
  calculated_amount numeric(12,2) not null default 0 check (calculated_amount >= 0),
  price_breakdown jsonb not null default '[]'::jsonb check (jsonb_typeof(price_breakdown) = 'array'),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict,
  version integer not null default 1 check (version > 0),
  constraint bookings_series_index_key unique (series_id, series_index),
  constraint bookings_local_range check (
    isfinite(starts_at) and isfinite(ends_at)
    and starts_at::date = ends_at::date and ends_at > starts_at
    and extract(second from starts_at) = 0 and extract(second from ends_at) = 0
    and extract(minute from starts_at) in (0, 30)
    and extract(minute from ends_at) in (0, 30)
  ),
  constraint bookings_cancellation_actor check (cancelled_at is not null or cancelled_by is null)
);
create index bookings_local_date_idx on public.bookings((starts_at::date));
create index bookings_teacher_start_idx on public.bookings(teacher_id, starts_at);
alter table public.bookings add constraint bookings_active_room_no_overlap
  exclude using gist (room with =, tsrange(starts_at, ends_at, '[)') with &&)
  where (cancelled_at is null);
alter table public.bookings add constraint bookings_active_teacher_no_overlap
  exclude using gist (teacher_id with =, tsrange(starts_at, ends_at, '[)') with &&)
  where (cancelled_at is null);

create function private.profile_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id then
      raise check_violation using message = 'profile_id_immutable';
    end if;
    if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
      raise check_violation using message = 'auth_user_id_immutable';
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := statement_timestamp();
  end if;
  if not new.active then
    new.access_token_hash := null;
  end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$$;
create trigger profiles_guard before insert or update on public.profiles
for each row execute function private.profile_guard();

create function private.actor_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profiles p
  where p.active and p.auth_user_id = auth.uid()
$$;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = private.actor_id() and p.role = 'admin'
  )
$$;
create function private.can_manage(p_teacher_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.actor_id() is not null
    and (p_teacher_id = private.actor_id() or private.is_admin())
$$;

create function public.resolve_access(p_token_hash text)
returns table(id uuid, name text, role public.app_role, auth_user_id uuid)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.role, p.auth_user_id
  from public.profiles p
  where p.active and p.access_token_hash = p_token_hash
    and p_token_hash ~ '^[0-9a-f]{64}$'
$$;

create function private.issue_access_link(p_profile_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare token text;
begin
  token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.profiles
     set access_token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
   where id = p_profile_id and active;
  if not found then
    raise no_data_found using message = 'active_profile_required';
  end if;
  return token;
end;
$$;

create function private.class_guard() returns trigger
language plpgsql set search_path = '' as $$
declare actor uuid := private.actor_id();
begin
  if actor is null and current_user not in ('postgres', 'supabase_admin') then
    raise insufficient_privilege using message = 'active_profile_required';
  end if;
  if tg_op = 'INSERT' then
    if actor is not null and not private.is_admin() then
      if new.teacher_id is not null and new.teacher_id <> actor then
        raise insufficient_privilege using message = 'class_owner_forbidden';
      end if;
      new.teacher_id := actor;
    end if;
    if not exists (
      select 1 from public.profiles p
      where p.id = new.teacher_id and p.role = 'teacher' and p.active
    ) then
      raise check_violation using message = 'active_teacher_required';
    end if;
    new.created_at := statement_timestamp();
    new.created_by := actor;
  else
    if new.id <> old.id or new.teacher_id <> old.teacher_id then
      raise check_violation using message = 'class_owner_immutable';
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := statement_timestamp();
  new.updated_by := actor;
  return new;
end;
$$;
create trigger classes_guard before insert or update on public.classes
for each row execute function private.class_guard();

create function private.booking_guard() returns trigger
language plpgsql set search_path = '' as $$
declare actor uuid := private.actor_id(); owner_id uuid;
begin
  if actor is null and current_user not in ('postgres', 'supabase_admin') then
    raise insufficient_privilege using message = 'active_profile_required';
  end if;
  select c.teacher_id into owner_id from public.classes c where c.id = new.class_id;
  if not found then
    raise foreign_key_violation using message = 'class_not_found';
  end if;
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.classes c join public.profiles p on p.id = c.teacher_id
      where c.id = new.class_id and c.active and p.active
    ) then
      raise check_violation using message = 'active_class_required';
    end if;
    new.teacher_id := owner_id;
    new.created_at := statement_timestamp();
    new.created_by := actor;
    new.version := 1;
  else
    if old.cancelled_at is not null then
      raise check_violation using message = 'cancelled_booking_read_only';
    end if;
    if new.id <> old.id or new.series_id <> old.series_id or new.series_index <> old.series_index
       or new.teacher_id <> old.teacher_id then
      raise check_violation using message = 'booking_identity_immutable';
    end if;
    if owner_id <> old.teacher_id then
      raise check_violation using message = 'booking_teacher_immutable';
    end if;
    if new.cancelled_at is not null then
      new.cancelled_at := statement_timestamp();
      new.cancelled_by := actor;
    else
      new.cancelled_by := null;
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.version := old.version + 1;
  end if;
  new.updated_at := statement_timestamp();
  new.updated_by := actor;
  return new;
end;
$$;
create trigger bookings_guard before insert or update on public.bookings
for each row execute function private.booking_guard();

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.bookings enable row level security;
alter table private.pricing_rules enable row level security;

revoke all on public.profiles, public.classes, public.bookings from public, anon, authenticated;
revoke all on private.pricing_rules from public, anon, authenticated;
revoke all on function public.resolve_access(text) from public, anon, authenticated;
revoke all on function private.issue_access_link(uuid), private.profile_guard(), private.class_guard(), private.booking_guard()
  from public, anon, authenticated, service_role;
revoke all on function private.actor_id(), private.is_admin(), private.can_manage(uuid)
  from public, anon, authenticated;

grant usage on schema private to authenticated;
grant execute on function private.actor_id(), private.is_admin(), private.can_manage(uuid) to authenticated;
grant execute on function public.resolve_access(text) to service_role;

grant select(id, name, role, active, created_at, updated_at) on public.profiles to authenticated;
create policy profiles_read_active on public.profiles for select to authenticated
using (private.actor_id() is not null);

grant select on public.classes to authenticated;
grant insert(teacher_id, name, active) on public.classes to authenticated;
grant update(name, active) on public.classes to authenticated;
create policy classes_read_active on public.classes for select to authenticated
using (private.actor_id() is not null);
create policy classes_insert_managed on public.classes for insert to authenticated
with check (private.can_manage(teacher_id));
create policy classes_update_managed on public.classes for update to authenticated
using (private.can_manage(teacher_id)) with check (private.can_manage(teacher_id));

-- A2: authoritative pricing and booking-series mutations.
create function private.require_active_managed_class(p_class_id uuid)
returns public.classes
language plpgsql security definer set search_path = '' as $$
declare class_row public.classes%rowtype;
begin
  if private.actor_id() is null then
    raise insufficient_privilege using message = 'active_profile_required';
  end if;
  select c.* into class_row from public.classes c where c.id = p_class_id for share;
  if not found then raise sqlstate 'PT404' using message = 'class_not_found'; end if;
  if not private.can_manage(class_row.teacher_id) then
    raise insufficient_privilege using message = 'class_forbidden';
  end if;
  if not class_row.active or not exists (
    select 1 from public.profiles p where p.id = class_row.teacher_id and p.active
  ) then
    raise sqlstate 'PT422' using message = 'active_class_required';
  end if;
  return class_row;
end;
$$;

create function private.occurrence_rows(p_occurrences jsonb)
returns table(occurrence_index integer, starts_at timestamp without time zone, ends_at timestamp without time zone)
language plpgsql stable set search_path = '' as $$
declare
  item jsonb;
  start_text text;
  end_text text;
  seen_ranges tsrange[] := array[]::tsrange[];
  normalized_range tsrange;
begin
  if p_occurrences is null
     or jsonb_typeof(p_occurrences) is distinct from 'array' then
    raise sqlstate 'PT422' using message = 'invalid_occurrences';
  end if;
  if jsonb_array_length(p_occurrences) not between 1 and 104 then
    raise sqlstate 'PT422' using message = 'invalid_occurrences';
  end if;
  occurrence_index := 0;
  for item in select value from jsonb_array_elements(p_occurrences) as x(value) loop
    occurrence_index := occurrence_index + 1;
    if jsonb_typeof(item) is distinct from 'object'
       or jsonb_typeof(item -> 'starts_at') is distinct from 'string'
       or jsonb_typeof(item -> 'ends_at') is distinct from 'string' then
      raise sqlstate 'PT422' using message = 'invalid_occurrences';
    end if;
    start_text := item ->> 'starts_at'; end_text := item ->> 'ends_at';
    if start_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$'
       or end_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$' then
      raise sqlstate 'PT422' using message = 'invalid_local_range';
    end if;
    starts_at := start_text::timestamp; ends_at := end_text::timestamp;
    if not isfinite(starts_at) or not isfinite(ends_at)
       or starts_at::date <> ends_at::date or ends_at <= starts_at
       or extract(minute from starts_at) not in (0, 30)
       or extract(minute from ends_at) not in (0, 30) then
      raise sqlstate 'PT422' using message = 'invalid_local_range';
    end if;
    normalized_range := tsrange(starts_at, ends_at, '[)');
    if normalized_range = any(seen_ranges) then
      raise sqlstate 'PT422' using message = 'duplicate_occurrence';
    end if;
    seen_ranges := array_append(seen_ranges, normalized_range);
    return next;
  end loop;
end;
$$;

create function private.price_occurrence(
  p_teacher_id uuid, p_starts_at timestamp without time zone, p_ends_at timestamp without time zone
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  segment_start timestamp without time zone; segment_end timestamp without time zone;
  winning_level integer; candidate_count integer;
  rule_id uuid; rule_label text; rate numeric(12,2); subtotal numeric(12,2);
  segments jsonb := '[]'::jsonb; total numeric(12,2) := 0;
begin
  for segment_start in select generate_series(p_starts_at, p_ends_at - interval '30 minutes', interval '30 minutes')::timestamp loop
    segment_end := segment_start + interval '30 minutes';
    with candidates as (
      select r.*, case
        when r.teacher_id = p_teacher_id and r.start_time is not null then 1
        when r.teacher_id = p_teacher_id and r.start_time is null then 2
        else 3 end as level
      from private.pricing_rules r
      where r.active
        and extract(isodow from segment_start)::smallint = any(r.weekdays)
        and (
          (r.teacher_id = p_teacher_id and r.start_time is not null
            and r.start_time <= segment_start::time and r.end_time >= segment_end::time)
          or (r.teacher_id = p_teacher_id and r.start_time is null and r.end_time is null)
          or (r.teacher_id is null and r.start_time is not null
            and r.start_time <= segment_start::time and r.end_time >= segment_end::time)
        )
    ), level_choice as (select min(level) as level from candidates),
    priority_choice as (
      select max(c.priority) as priority from candidates c join level_choice l on l.level = c.level
    )
    select count(*), (array_agg(c.id))[1], (array_agg(c.label))[1], (array_agg(c.hourly_rate))[1],
           (select level from level_choice)
      into candidate_count, rule_id, rule_label, rate, winning_level
      from candidates c
      where c.level = (select level from level_choice)
        and c.priority = (select priority from priority_choice);
    if winning_level is null or candidate_count <> 1 then
      raise sqlstate 'PT422' using message = 'pricing_configuration_error',
        detail = jsonb_build_object('starts_at', segment_start, 'ends_at', segment_end)::text;
    end if;
    subtotal := round(rate / 2, 2); total := total + subtotal;
    segments := segments || jsonb_build_array(jsonb_build_object(
      'starts_at', to_char(segment_start, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_at', to_char(segment_end, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'rule_id', rule_id, 'label', rule_label,
      'hourly_rate', to_char(rate, 'FM9999999990.00'),
      'subtotal', to_char(subtotal, 'FM9999999990.00')
    ));
  end loop;
  return jsonb_build_object('amount', to_char(round(total, 2), 'FM9999999990.00'), 'segments', segments);
end;
$$;

create function private.booking_conflicts(
  p_teacher_id uuid, p_room public.room, p_starts_at timestamp without time zone,
  p_ends_at timestamp without time zone, p_exclude_id uuid default null
) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('date', b.starts_at::date, 'room', b.room)
    order by b.starts_at, b.room), '[]'::jsonb)
  from public.bookings b
  where b.cancelled_at is null and b.id is distinct from p_exclude_id
    and (b.room = p_room or b.teacher_id = p_teacher_id)
    and tsrange(b.starts_at, b.ends_at, '[)') && tsrange(p_starts_at, p_ends_at, '[)')
$$;

create function private.booking_payload(p_booking public.bookings) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_booking.id, 'series_id', p_booking.series_id, 'series_index', p_booking.series_index,
    'teacher_id', p_booking.teacher_id, 'class_id', p_booking.class_id, 'room', p_booking.room,
    'starts_at', to_char(p_booking.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'ends_at', to_char(p_booking.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'student_details', p_booking.student_details, 'currency', p_booking.currency,
    'amount', to_char(p_booking.calculated_amount, 'FM9999999990.00'),
    'segments', p_booking.price_breakdown, 'cancelled_at', p_booking.cancelled_at,
    'cancelled_by', p_booking.cancelled_by, 'version', p_booking.version
  )
$$;

create function public.quote_booking(
  p_class_id uuid, p_room public.room, p_occurrences jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare class_row public.classes%rowtype; occurrence record; priced jsonb;
  result jsonb := '[]'::jsonb; total numeric(12,2) := 0;
begin
  class_row := private.require_active_managed_class(p_class_id);
  if p_room is null then raise sqlstate 'PT422' using message = 'invalid_room'; end if;
  for occurrence in select * from private.occurrence_rows(p_occurrences) loop
    priced := private.price_occurrence(class_row.teacher_id, occurrence.starts_at, occurrence.ends_at);
    total := total + (priced ->> 'amount')::numeric;
    result := result || jsonb_build_array(jsonb_build_object(
      'occurrence_index', occurrence.occurrence_index, 'starts_at', to_char(occurrence.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'ends_at', to_char(occurrence.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'duration_minutes', (extract(epoch from occurrence.ends_at - occurrence.starts_at) / 60)::integer,
      'amount', priced ->> 'amount', 'segments', priced -> 'segments',
      'conflicts', private.booking_conflicts(class_row.teacher_id, p_room, occurrence.starts_at, occurrence.ends_at)
    ));
  end loop;
  return jsonb_build_object('occurrences', result, 'total_amount', to_char(round(total, 2), 'FM9999999990.00'));
end;
$$;

create function public.create_booking_series(
  p_class_id uuid, p_room public.room, p_student_details text, p_occurrences jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  class_row public.classes%rowtype; occurrence record; other record; priced jsonb;
  new_series_id uuid := extensions.gen_random_uuid(); booked public.bookings%rowtype;
  next_series_index integer := 0;
  inserted jsonb := '[]'::jsonb;
begin
  class_row := private.require_active_managed_class(p_class_id);
  if p_room is null then raise sqlstate 'PT422' using message = 'invalid_room'; end if;
  if p_student_details is not null and (p_student_details <> btrim(p_student_details) or char_length(p_student_details) > 1000) then
    raise sqlstate 'PT422' using message = 'invalid_student_details';
  end if;
  for occurrence in select * from private.occurrence_rows(p_occurrences) loop
    if private.booking_conflicts(class_row.teacher_id, p_room, occurrence.starts_at, occurrence.ends_at) <> '[]'::jsonb then
      raise sqlstate 'PT409' using message = 'booking_conflict';
    end if;
    for other in select * from private.occurrence_rows(p_occurrences) where occurrence_index < occurrence.occurrence_index loop
      if tsrange(other.starts_at, other.ends_at, '[)') && tsrange(occurrence.starts_at, occurrence.ends_at, '[)') then
        raise sqlstate 'PT409' using message = 'booking_conflict';
      end if;
    end loop;
  end loop;
  for occurrence in select * from private.occurrence_rows(p_occurrences) order by starts_at, ends_at loop
    priced := private.price_occurrence(class_row.teacher_id, occurrence.starts_at, occurrence.ends_at);
    insert into public.bookings(series_id, series_index, teacher_id, class_id, room, starts_at, ends_at,
      student_details, currency, calculated_amount, price_breakdown)
    values (new_series_id, next_series_index, class_row.teacher_id, p_class_id, p_room,
      occurrence.starts_at, occurrence.ends_at, p_student_details, 'EUR', (priced ->> 'amount')::numeric,
      priced -> 'segments') returning * into booked;
    inserted := inserted || jsonb_build_array(private.booking_payload(booked));
    next_series_index := next_series_index + 1;
  end loop;
  return jsonb_build_object('series_id', new_series_id, 'bookings', inserted);
exception when exclusion_violation then
  raise sqlstate 'PT409' using message = 'booking_conflict';
end;
$$;

create function public.edit_booking(
  p_id uuid, p_expected_version integer, p_class_id uuid, p_room public.room,
  p_starts_at timestamp without time zone, p_ends_at timestamp without time zone, p_student_details text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare booking_row public.bookings%rowtype; class_row public.classes%rowtype;
  occurrence record; priced jsonb;
begin
  if private.actor_id() is null then raise insufficient_privilege using message = 'active_profile_required'; end if;
  select * into booking_row from public.bookings where id = p_id for update;
  if not found then raise sqlstate 'PT404' using message = 'booking_not_found'; end if;
  if not private.can_manage(booking_row.teacher_id) then raise insufficient_privilege using message = 'booking_forbidden'; end if;
  if booking_row.cancelled_at is not null then raise sqlstate 'PT409' using message = 'cancelled_booking_read_only'; end if;
  if p_expected_version is distinct from booking_row.version then raise sqlstate 'PT409' using message = 'stale_booking'; end if;
  class_row := private.require_active_managed_class(p_class_id);
  if class_row.teacher_id <> booking_row.teacher_id then raise sqlstate 'PT422' using message = 'booking_teacher_immutable'; end if;
  if p_room is null then raise sqlstate 'PT422' using message = 'invalid_room'; end if;
  if p_student_details is not null and (p_student_details <> btrim(p_student_details) or char_length(p_student_details) > 1000) then
    raise sqlstate 'PT422' using message = 'invalid_student_details';
  end if;
  if p_starts_at is null or p_ends_at is null
     or not isfinite(p_starts_at) or not isfinite(p_ends_at)
     or p_starts_at::date <> p_ends_at::date or p_ends_at <= p_starts_at
     or extract(minute from p_starts_at) not in (0, 30)
     or extract(minute from p_ends_at) not in (0, 30)
     or extract(second from p_starts_at) <> 0
     or extract(second from p_ends_at) <> 0 then
    raise sqlstate 'PT422' using message = 'invalid_local_range';
  end if;
  select * into occurrence from private.occurrence_rows(jsonb_build_array(jsonb_build_object(
    'starts_at', to_char(p_starts_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
    'ends_at', to_char(p_ends_at, 'YYYY-MM-DD"T"HH24:MI:SS')
  )));
  if private.booking_conflicts(booking_row.teacher_id, p_room, occurrence.starts_at, occurrence.ends_at, p_id) <> '[]'::jsonb then
    raise sqlstate 'PT409' using message = 'booking_conflict';
  end if;
  priced := private.price_occurrence(booking_row.teacher_id, occurrence.starts_at, occurrence.ends_at);
  update public.bookings set class_id = p_class_id, room = p_room, starts_at = occurrence.starts_at,
    ends_at = occurrence.ends_at, student_details = p_student_details,
    calculated_amount = (priced ->> 'amount')::numeric, price_breakdown = priced -> 'segments'
  where id = p_id returning * into booking_row;
  return private.booking_payload(booking_row);
exception when exclusion_violation then
  raise sqlstate 'PT409' using message = 'booking_conflict';
end;
$$;

create function public.cancel_booking(p_id uuid, p_expected_version integer, p_scope text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare booking_row public.bookings%rowtype; affected public.bookings%rowtype;
  cancelled jsonb := '[]'::jsonb; count_cancelled integer := 0;
begin
  if private.actor_id() is null then raise insufficient_privilege using message = 'active_profile_required'; end if;
  if p_scope is null or p_scope not in ('one', 'future') then raise sqlstate 'PT422' using message = 'invalid_cancel_scope'; end if;
  select * into booking_row from public.bookings where id = p_id for update;
  if not found then raise sqlstate 'PT404' using message = 'booking_not_found'; end if;
  if not private.can_manage(booking_row.teacher_id) then raise insufficient_privilege using message = 'booking_forbidden'; end if;
  if booking_row.cancelled_at is null and p_expected_version is distinct from booking_row.version then
    raise sqlstate 'PT409' using message = 'stale_booking';
  end if;
  for affected in select * from public.bookings
    where series_id = booking_row.series_id and series_index >= booking_row.series_index
      and cancelled_at is null and (p_scope = 'future' or id = booking_row.id)
    order by series_index for update
  loop
    update public.bookings set cancelled_at = statement_timestamp() where id = affected.id returning * into affected;
    cancelled := cancelled || jsonb_build_array(private.booking_payload(affected));
    count_cancelled := count_cancelled + 1;
  end loop;
  return jsonb_build_object('bookings', cancelled, 'cancelled_count', count_cancelled);
end;
$$;

revoke all on function private.require_active_managed_class(uuid), private.occurrence_rows(jsonb),
  private.price_occurrence(uuid, timestamp without time zone, timestamp without time zone),
  private.booking_conflicts(uuid, public.room, timestamp without time zone, timestamp without time zone, uuid),
  private.booking_payload(public.bookings) from public, anon, authenticated;
revoke all on function public.quote_booking(uuid, public.room, jsonb),
  public.create_booking_series(uuid, public.room, text, jsonb),
  public.edit_booking(uuid, integer, uuid, public.room, timestamp without time zone, timestamp without time zone, text),
  public.cancel_booking(uuid, integer, text) from public, anon;
grant execute on function public.quote_booking(uuid, public.room, jsonb),
  public.create_booking_series(uuid, public.room, text, jsonb),
  public.edit_booking(uuid, integer, uuid, public.room, timestamp without time zone, timestamp without time zone, text),
  public.cancel_booking(uuid, integer, text) to authenticated;
