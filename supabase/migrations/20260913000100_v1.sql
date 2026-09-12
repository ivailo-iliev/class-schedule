create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema private;
revoke all on schema private from public, anon, authenticated;
revoke create on schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

create type public.app_role as enum ('admin', 'teacher');
create type public.room as enum ('room_1', 'room_2');

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  role public.app_role not null default 'teacher',
  active boolean not null default true,
  access_token_hash text unique check (access_token_hash ~ '^[0-9a-f]{64}$'),
  credential_version integer not null default 1 check (credential_version > 0),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);
create table public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete restrict,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict
);
create index classes_teacher_idx on public.classes(teacher_id);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete restrict,
  room public.room not null,
  starts_at timestamptz not null,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  created_by uuid references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict,
  version integer not null default 1 check (version > 0),
  active_slot timestamptz generated always as (
    case when cancelled_at is null then starts_at else null end
  ) stored,
  constraint bookings_room_active_slot_key unique (room, active_slot),
  constraint bookings_finite_start check (isfinite(starts_at)),
  constraint bookings_cancellation_actor check (
    cancelled_at is not null or cancelled_by is null
  )
);
create index bookings_start_idx on public.bookings(starts_at);
create index bookings_class_start_idx on public.bookings(class_id, starts_at);

create table private.annual_rates (
  year integer primary key check (year between 2000 and 9999),
  room_hour_rate numeric(12,2) not null check (room_hour_rate >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$')
);

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.bookings enable row level security;
alter table private.annual_rates enable row level security;
revoke all on public.profiles, public.classes, public.bookings
  from public, anon, authenticated;
revoke all on private.annual_rates from public, anon, authenticated;

-- A2: Profile credentials, trusted actor, and safe profile projection

create function private.profile_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.credential_version := 1;
    new.created_at := statement_timestamp();
  else
    if new.id <> old.id then
      raise check_violation using message = 'profile_id_immutable';
    end if;
    new.created_at := old.created_at;
    if new.access_token_hash is distinct from old.access_token_hash
       or new.active is distinct from old.active
       or new.role is distinct from old.role then
      new.credential_version := old.credential_version + 1;
    else
      new.credential_version := old.credential_version;
    end if;
  end if;
  if not new.active then new.access_token_hash := null; end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$$;
create trigger profiles_guard before insert or update on public.profiles
for each row execute function private.profile_guard();

create function private.actor_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p
  where p.id = auth.uid()
    and p.active and p.access_token_hash is not null
    and auth.jwt()->>'app' = 'class-scheduler-v1'
    and auth.jwt()->>'credential_version' = p.credential_version::text;
$$;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = private.actor_id() and p.role = 'admin'
  );
$$;
create function private.can_manage(p_teacher_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.actor_id() is not null and
    (p_teacher_id = private.actor_id() or private.is_admin());
$$;

create function public.resolve_access(p_token_hash text)
returns table(id uuid, name text, role public.app_role, credential_version integer)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.role, p.credential_version
  from public.profiles p
  where p.active and p.access_token_hash = p_token_hash
    and p_token_hash ~ '^[0-9a-f]{64}$';
$$;
revoke all on function public.resolve_access(text) from public, anon, authenticated;
grant execute on function public.resolve_access(text) to service_role;

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
revoke all on function private.issue_access_link(uuid) from public, anon, authenticated, service_role;
revoke all on function private.profile_guard() from public, anon, authenticated;
revoke all on function private.actor_id(), private.is_admin(), private.can_manage(uuid)
  from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.actor_id(), private.is_admin(), private.can_manage(uuid)
  to authenticated;

grant select(id, name, role, active, created_at, updated_at)
  on public.profiles to authenticated;
create policy profiles_read on public.profiles for select to authenticated
using ((select private.actor_id()) is not null);

-- A3. Class assignment, immutability, and RLS

create function private.class_guard() returns trigger
language plpgsql set search_path = '' as $$
declare actor uuid := private.actor_id();
begin
  if actor is null and current_user not in ('postgres', 'supabase_admin') then
    raise insufficient_privilege using message = 'access_required';
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
revoke all on function private.class_guard() from public, anon, authenticated;
create trigger classes_guard before insert or update on public.classes
for each row execute function private.class_guard();

grant select on public.classes to authenticated;
grant insert(teacher_id, name, active) on public.classes to authenticated;
grant update(name, active) on public.classes to authenticated;
create policy classes_read on public.classes for select to authenticated
using ((select private.actor_id()) is not null);
create policy classes_insert on public.classes for insert to authenticated
with check (private.can_manage(teacher_id));
create policy classes_update on public.classes for update to authenticated
using (private.can_manage(teacher_id))
with check (private.can_manage(teacher_id));

-- A4. Local-hour validation and booking guards

create function private.valid_slot(p_instant timestamptz) returns boolean
language sql stable set search_path = '' as $$
  select case when p_instant is null or not isfinite(p_instant) then false else
    (p_instant at time zone 'Europe/Sofia') =
      date_trunc('hour', p_instant at time zone 'Europe/Sofia')
    and ((p_instant - interval '1 hour') at time zone 'Europe/Sofia') <>
      (p_instant at time zone 'Europe/Sofia')
    and ((p_instant + interval '1 hour') at time zone 'Europe/Sofia') <>
      (p_instant at time zone 'Europe/Sofia')
  end;
$$;
create function private.resolve_slot(p_date date, p_hour integer) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare wall timestamp; instant timestamptz;
begin
  if p_date is null or not isfinite(p_date) or p_hour is null or p_hour not between 0 and 23 then
    raise sqlstate 'PT422' using message = 'invalid_slot';
  end if;
  wall := p_date + make_time(p_hour, 0, 0);
  instant := wall at time zone 'Europe/Sofia';
  if (instant at time zone 'Europe/Sofia') <> wall or not private.valid_slot(instant) then
    raise sqlstate 'PT422' using message = 'invalid_slot',
      detail = jsonb_build_object('date', p_date, 'hour', p_hour)::text;
  end if;
  return instant;
end;
$$;
alter table public.bookings add constraint bookings_valid_hour
  check (private.valid_slot(starts_at));

create function private.booking_guard() returns trigger
language plpgsql set search_path = '' as $$
declare actor uuid := private.actor_id(); owner_row public.classes%rowtype;
begin
  if actor is null and current_user not in ('postgres', 'supabase_admin') then
    raise insufficient_privilege using message = 'access_required';
  end if;
  select * into owner_row from public.classes where id = new.class_id for share;
  if not found then raise foreign_key_violation using message = 'class_not_found'; end if;
  if tg_op = 'INSERT' then
    if not owner_row.active or not exists (
      select 1 from public.profiles p where p.id = owner_row.teacher_id and p.active
    ) then raise check_violation using message = 'active_class_required'; end if;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.created_at := statement_timestamp();
    new.created_by := actor;
    new.version := 1;
  else
    if old.cancelled_at is not null then
      raise check_violation using message = 'cancelled_booking_read_only';
    end if;
    if new.id <> old.id then raise check_violation using message = 'booking_id_immutable'; end if;
    if new.class_id <> old.class_id and (not owner_row.active or not exists (
      select 1 from public.profiles p where p.id = owner_row.teacher_id and p.active
    )) then raise check_violation using message = 'active_class_required'; end if;
    if new.cancelled_at is not null then
      if row(new.class_id, new.room, new.starts_at) is distinct from
         row(old.class_id, old.room, old.starts_at) then
        raise check_violation using message = 'cancel_without_editing';
      end if;
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
revoke all on function private.valid_slot(timestamptz), private.resolve_slot(date, integer),
  private.booking_guard() from public, anon, authenticated;
grant execute on function private.valid_slot(timestamptz), private.resolve_slot(date, integer)
  to authenticated;
create trigger bookings_guard before insert or update on public.bookings
for each row execute function private.booking_guard();

grant select on public.bookings to authenticated;
grant insert(class_id, room, starts_at) on public.bookings to authenticated;
grant update(class_id, room, starts_at, cancelled_at) on public.bookings to authenticated;
create policy bookings_read on public.bookings for select to authenticated
using ((select private.actor_id()) is not null);
create policy bookings_insert on public.bookings for insert to authenticated
with check (exists (
  select 1 from public.classes c
  where c.id = class_id and private.can_manage(c.teacher_id)
));
create policy bookings_update on public.bookings for update to authenticated
using (exists (
  select 1 from public.classes c
  where c.id = class_id and private.can_manage(c.teacher_id)
))
with check (exists (
  select 1 from public.classes c
  where c.id = class_id and private.can_manage(c.teacher_id)
));
