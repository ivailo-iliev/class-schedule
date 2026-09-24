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
