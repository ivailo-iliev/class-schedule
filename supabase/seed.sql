-- Local synthetic fixtures only. Never contains real credentials or production data.
-- Loaded by the db owner (postgres) during `supabase db reset --local`, so RLS
-- does not block inserts here.

-- Deterministic UUIDs so database tests can reference stable identities.
insert into public.profiles (id, name, role, active, access_token_hash)
values
  ('11111111-1111-1111-1111-111111111111', 'Teacher A', 'teacher', true,
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('22222222-2222-2222-2222-222222222222', 'Teacher B', 'teacher', true,
     'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  ('33333333-3333-3333-3333-333333333333', 'Admin One', 'admin', true,
     'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
on conflict (id) do nothing;

insert into public.classes (id, teacher_id, name, active)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Morning Yoga', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Evening Pilates', true)
on conflict (id) do nothing;

-- A couple of existing bookings so the daily-schedule read has data to return.
insert into public.bookings (id, class_id, room, starts_at)
values
  ('cabababa-0001-0001-0001-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'room_1',
     (date '2026-09-15' + make_time(9, 0, 0)) at time zone 'Europe/Sofia'),
  ('cabababa-0002-0002-0002-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'room_2',
     (date '2026-09-15' + make_time(10, 0, 0)) at time zone 'Europe/Sofia')
on conflict (id) do nothing;

insert into private.room_rate (room_hour_rate, currency)
values (20.00, 'BGN')
on conflict (singleton) do update set room_hour_rate = excluded.room_hour_rate,
  currency = excluded.currency;
