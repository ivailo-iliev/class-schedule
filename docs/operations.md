# Operations — Supabase-only administration and reporting

This document records the direct Supabase (SQL Editor, Table Editor, or CLI)
operations for this project. There is no billing UI, reporting app surface,
profile-administration screen, or export endpoint in the application. Every
task below runs in the Supabase Dashboard SQL Editor, Table Editor, or via the
Supabase CLI against the target project (local or hosted).

> **Rule:** the application has no custom reporting API. `get_day` is the only
> read RPC used by the app's daily schedule; all billing/export/administration
> work is done here, by an owner, in Supabase directly. Never commit `.env`,
> credentials, or personal access-link tokens into the repository.

## Netlify deployment and environment isolation

`netlify.toml` is the deployment source of truth. Netlify builds with Node 24
using `npm run build`, publishes `dist`, and loads functions from
`netlify/functions`. The access function owns `/api/access` and appears before
the final `/*` SPA fallback so its errors cannot become an HTML 200 response.
Its Netlify rate limit is 60 requests per IP/domain per 60 seconds.

Configure environment variables in Netlify's site settings, not in this
repository:

- Production build variables: `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY`. These are intentionally public and are the
  only Supabase variables available to the Vite client bundle.
- Production function variables: `SUPABASE_URL`,
  `SUPABASE_SECRET_API_KEY`, and `APP_ORIGIN`. Keep these scoped to Functions
  or the production context; never prefix a secret with `VITE_`.
- Deploy previews: use a separate disposable Supabase project or local/test
  values for both public variables and function variables. Do not inherit
  production `SUPABASE_SECRET_API_KEY`, production database credentials, or
  any production write access into a preview context.

There are no signing-key, JWKS, or custom-JWT variables in this native-session
design. Frontend builds never run Supabase migrations. Before accepting a
deployment, inspect the generated `dist` with `npm run check:public-build` and
verify the production response headers include CSP, `Referrer-Policy:
no-referrer`, and `X-Content-Type-Options: nosniff`.

## Default timezone

The application assumes `Europe/Sofia`. Confirm or change this in the timing
RPCs (`private.resolve_slot`, `private.valid_slot`, `get_day`) and in the
billability queries below before storing production bookings. Existing stored
`timestamptz` values retain their UTC instant, so a timezone change would
display a different local time for historical data.

## Profile administration

### Create a profile and issue a personal access link

```sql
insert into public.profiles (name, role) values ('Maria', 'teacher');
select private.issue_access_link('<inserted-uuid>');
```

Call `private.issue_access_link` from the `postgres` or `supabase_admin` role
via SQL Editor; no other role has EXECUTE privilege. It sets the SHA-256 hash
and returns the raw 64-char token. The administrator copies and distributes the
raw token as `APP_ORIGIN/access#<returned-token>`. Never paste real links into
the repository, task descriptions, fixtures, CI output, or chat logs.

### Replace a compromised link

```sql
select private.issue_access_link('<profile-uuid>');
```

### Deactivate a teacher (revokes access on the next DB statement)

```sql
update public.profiles set active = false where id = '<profile-uuid>';
```

### Revoke then reactivate

Reactivation alone does not restore the old link — issue a new one:

```sql
update public.profiles set active = true where id = '<profile-uuid>';
-- Then issue a new link separately
select private.issue_access_link('<profile-uuid>');
```

## Current room-hour rate

`private.room_rate` contains one current rate, not a year-indexed rate history.
The singleton key permits zero or one row so a missing configuration can be
reported explicitly; it prevents a second current rate. Change it only as an
owner in the SQL Editor or Table Editor:

```sql
insert into private.room_rate (room_hour_rate, currency)
values (20.00, 'BGN')
on conflict (singleton) do update set room_hour_rate = excluded.room_hour_rate,
  currency = excluded.currency;
```

Run this preflight before every billing report. A missing row is an operational
error, never a zero-rate result:

```sql
select case when count(*) = 1 then 'current_rate_ready'
            else 'missing_current_room_rate' end as status
from private.room_rate;
```

Do not run or interpret a billing report until the result is
`current_rate_ready`. The report multiplies uncancelled hours by this current
rate for every booking date and returns the currency with each money total.


## Monthly usage report

Total billed uncancelled hours per teacher/class/room, grouped by year-month.
Parameterized by the year-month window:

```sql
with current_rate as (
  select room_hour_rate, currency
  from private.room_rate
  where singleton
)
select p.id as teacher_id, p.name as teacher, c.id as class_id, c.name as class, b.room,
  to_char(date_trunc('month', b.starts_at at time zone 'Europe/Sofia'), 'YYYY-MM-DD') as month,
  count(b.id) as uncancelled_hours,
  r.room_hour_rate,
  r.currency,
  (count(b.id)::numeric * r.room_hour_rate)::numeric(12,2) as billed_total
from public.bookings b
join public.classes c on c.id = b.class_id
join public.profiles p on p.id = c.teacher_id
cross join current_rate r
where b.cancelled_at is null
  and b.starts_at >= (:start_date::date::timestamp at time zone 'Europe/Sofia')
  and b.starts_at <  (:end_date::date::timestamp at time zone 'Europe/Sofia')
group by p.id, p.name, c.id, c.name, b.room, month, r.room_hour_rate, r.currency
order by p.name, p.id, month, b.room, c.name, c.id;
```

Each row includes a money total for its teacher/class/room/month grouping.
For a single total per teacher over the same window, run:

```sql
with current_rate as (
  select room_hour_rate, currency
  from private.room_rate
  where singleton
)
select p.id as teacher_id, p.name as teacher,
  count(b.id) as uncancelled_hours,
  r.room_hour_rate,
  r.currency,
  (count(b.id)::numeric * r.room_hour_rate)::numeric(12,2) as billed_total
from public.bookings b
join public.classes c on c.id = b.class_id
join public.profiles p on p.id = c.teacher_id
cross join current_rate r
where b.cancelled_at is null
  and b.starts_at >= (:start_date::date::timestamp at time zone 'Europe/Sofia')
  and b.starts_at <  (:end_date::date::timestamp at time zone 'Europe/Sofia')
group by p.id, p.name, r.room_hour_rate, r.currency
order by p.name, p.id;
```

For September 2026: `:start_date = '2026-09-01'`, `:end_date = '2026-10-01'`.

## Cancelled hours (reported separately)

```sql
select p.id as teacher_id, p.name as teacher, c.id as class_id, c.name as class, b.room,
  count(b.id) as cancelled_hours
from public.bookings b
join public.classes c on c.id = b.class_id
join public.profiles p on p.id = c.teacher_id
where b.cancelled_at is not null
  and b.cancelled_at >= (:start_date::date::timestamp at time zone 'Europe/Sofia')
  and b.cancelled_at <  (:end_date::date::timestamp at time zone 'Europe/Sofia')
group by p.id, p.name, c.id, c.name, b.room
order by p.name, p.id, c.name, c.id, b.room;
```

Cancellation is nonbillable in the default usage query; cancelled rows are
never counted as billable hours.

## Export all bookings for a period (CSV)

Supabase Table Editor provides a direct CSV download for the `public.bookings`
join below. This SQL produces the same data:

```sql
select b.id, p.id as teacher_id, p.name as teacher, c.id as class_id, c.name as class, b.room,
  b.starts_at at time zone 'Europe/Sofia' as local_start,
  b.cancelled_at at time zone 'Europe/Sofia' as local_cancelled,
  b.version, b.created_at at time zone 'Europe/Sofia' as created_local
from public.bookings b
join public.classes c on c.id = b.class_id
join public.profiles p on p.id = c.teacher_id
where b.starts_at >= (:start_date::date::timestamp at time zone 'Europe/Sofia')
  and b.starts_at <  (:end_date::date::timestamp at time zone 'Europe/Sofia')
order by b.starts_at, b.id;
```

## Holiday closures

There is no holiday-exclusion table or automation in V1. An administrator
simply inserts no bookings on a closed day, or manually removes a single
conflicting slot after coordination. This is an operational communication task,
not a technical guard.

## Restore a paused Supabase Free project

Log into Supabase Dashboard → project → a paused banner appears → click Resume.
This can take several minutes. The application landing page shows a public
connectivity error during pause. No scheduled keep-alive is part of V1.

## Backups (administrator responsibility)

Backups are not automatic on the Free plan. Export via `pg_dump` or the
Supabase CLI before any risky operational change:

```bash
pg_dump --dbname "$SUPABASE_DB_URL" --schema=public --schema=private \
  --no-owner --no-acl > backup-$(date -I).sql
```

The application has no export/billing UI; periodic exports are the
administrator's responsibility. The root-level `backup-YYYY-MM-DD.sql`
output is ignored by git.

## Changing the studio timezone after initial booking data

Update `private.resolve_slot`, `private.valid_slot`, `get_day`, and the
billability queries above to the new zone. Existing stored `timestamptz` values
keep their UTC instant and would display a different local time. If the real
timezone differs from `Europe/Sofia`, change all references before storing
production data and notify the implementer. No migration script is provided.
