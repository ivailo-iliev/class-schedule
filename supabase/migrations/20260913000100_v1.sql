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
