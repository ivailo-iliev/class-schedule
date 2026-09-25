-- Local synthetic fixtures only. Never contains real credentials or production data.
-- IDs are stable so pricing rules and database tests never resolve teachers by display name.

insert into public.profiles (id, name, role, active, access_token_hash, auth_user_id)
values
  ('11111111-1111-1111-1111-111111111111', 'Елеонора', 'teacher', true,
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222', 'Силвия', 'teacher', true,
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333', 'Admin One', 'admin', true,
   'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444', 'Галя', 'teacher', true,
   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '44444444-4444-4444-4444-444444444444'),
  ('55555555-5555-5555-5555-555555555555', 'Мария Бакалова', 'teacher', true,
   'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '55555555-5555-5555-5555-555555555555')
on conflict (id) do nothing;

insert into public.classes (id, teacher_id, name, active)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Morning Yoga', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'Evening Pilates', true)
on conflict (id) do nothing;

insert into private.pricing_rules
  (id, teacher_id, weekdays, start_time, end_time, hourly_rate, priority, label, active)
values
  ('10000000-0000-0000-0000-000000000001', null, array[1,2,3,4,5]::smallint[], '08:30', '17:00', 10.00, 0, 'Стандартна делнична тарифа', true),
  ('10000000-0000-0000-0000-000000000002', null, array[1,2,3,4,5]::smallint[], '17:00', '20:00', 25.00, 0, 'Стандартна вечерна тарифа', true),
  ('10000000-0000-0000-0000-000000000003', null, array[6,7]::smallint[], '09:00', '13:00', 30.00, 0, 'Стандартна уикенд сутрин', true),
  ('10000000-0000-0000-0000-000000000004', null, array[6,7]::smallint[], '13:00', '15:00', 10.00, 0, 'Стандартен уикенд обед', true),
  ('10000000-0000-0000-0000-000000000005', null, array[6,7]::smallint[], '15:00', '19:00', 30.00, 0, 'Стандартна уикенд вечер', true),
  ('20000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', array[1,2,3,4,5,6,7]::smallint[], null, null, 10.00, 0, 'Елеонора целодневна тарифа', true),
  ('20000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', array[1,2,3,4,5,6,7]::smallint[], null, null, 10.00, 0, 'Силвия целодневна тарифа', true),
  ('20000000-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555555', array[1,2,3,4,5,6,7]::smallint[], null, null, 10.00, 0, 'Мария Бакалова целодневна тарифа', true),
  ('30000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', array[1,2,3,4]::smallint[], '13:30', '16:00', 0.00, 10, 'Занималня', true),
  ('30000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', array[1,2,3,4]::smallint[], '17:30', '19:30', 0.00, 10, 'Предучилищна/подготовка за първи клас', true)
on conflict (id) do nothing;
