# Operations — Supabase administration and reporting

This document records owner operations for the Class Scheduler deployment. Profiles
and pricing rules are administered in Supabase; the application exposes only the
narrow authenticated RPCs needed by the browser. Never commit `.env` files,
Supabase secrets, database dumps, raw access tokens, or production identifiers.

## Deployment and environment isolation

`netlify.toml` is the deployment source of truth:

- Netlify uses Node 24, runs `npm run build`, publishes `dist`, and loads
  functions from `netlify/functions`.
- The only application function route is `/api/access`. The public
  `dist/manifest.webmanifest` is a static asset.
- The `/api/access` redirect and the API 404 fallback precede the final SPA
  fallback. Function failures must not become an HTML 200 response.
- The access function rate limit is 60 requests per IP/domain per 60 seconds.
- The static manifest has `start_url: "/"`, `scope: "/"`, and standalone display;
  there is no service worker, offline cache, background sync, or install cookie.

Configure environment variables in Netlify site settings, never in this
repository:

- Build variables: `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY`. They are public and are the only Supabase
  variables allowed in the Vite client bundle.
- Function variables: `SUPABASE_URL`, `SUPABASE_SECRET_API_KEY`, and
  `APP_ORIGIN`. Keep these in the Functions/production context and never prefix
  a secret with `VITE_`.
- Deploy previews: use a separate disposable Supabase project or local/test
  values for both sets of variables. Do not inherit production secret keys,
  database credentials, or production write access into a preview.

There are no signing-key, JWKS, or custom-JWT variables in the native-session
design. Frontend builds do not apply Supabase migrations. Before accepting a
build, run `npm run check:public-build` against the generated `dist` and read
back the production security headers: CSP, `Referrer-Policy: no-referrer`, and
`X-Content-Type-Options: nosniff`. The `/api/access` response is private and
`no-store`.

## Data and pricing invariants

- Booking `starts_at` and `ends_at` are local wall-clock values stored as
  PostgreSQL `timestamp without time zone`. They must be on one local calendar
  date, use whole seconds, and begin/end on a 00 or 30 minute boundary.
- Audit fields are instants. Do not reinterpret booking values as UTC or apply
  an offset when displaying or filtering a local date.
- `private.pricing_rules` is the authoritative configuration. It is maintained
  only by a Supabase owner through the Dashboard SQL Editor/Table Editor or an
  approved administrative migration; it is not exposed to authenticated
  browsers and there is no pricing-management screen.
- Each booking stores `currency = 'EUR'`, a nonnegative `calculated_amount`, and
  a `price_breakdown` JSON snapshot containing the applied segment rules, labels,
  hourly rates, and subtotals. Rule changes affect new quotes and new/edited
  bookings only; existing snapshots do not change.
- Pricing is resolved by trusted database code in 30-minute segments. A missing
  or ambiguous rule is a configuration error, never an implicit zero price.
- Cancellation frees the schedule and retains the original snapshot. The
  cancelled row remains in authorized reports, but its effective amount due is
  EUR 0.
- This is usage reporting, not payment collection, a wallet, a settlement
  ledger, or an account-balance system.

## Profile administration and reusable access links

Administrators manage profiles in Supabase, not in the application. Run these
statements as the `postgres` or `supabase_admin` role in the SQL Editor; do not
run them as a browser role:

```sql
insert into public.profiles (name, role)
values ('Teacher name', 'teacher');

select private.issue_access_link('<active-profile-uuid>');
```

`private.issue_access_link` returns a raw 64-character token once and stores
only its SHA-256 hash. Distribute it only as a reusable fragment link:

```text
https://<site-origin>/#<returned-token>
```

The browser posts the fragment token to `/api/access`, then clears the fragment
from the visible URL after the native Supabase session is established. The same
valid link can be opened on multiple devices. Never put a real token in source,
fixtures, CI output, tickets, chat, or this document.

To revoke access, deactivate the profile. Deactivation clears the stored hash
and blocks the profile on subsequent database calls, including established
sessions:

```sql
update public.profiles
set active = false
where id = '<active-profile-uuid>';
```

To reactivate a profile, set `active = true` and issue a new link separately.
Rotating a link invalidates the old link for future exchanges without signing
out sessions that are already established.

## Pricing-rule administration

Pricing rules are Supabase-administered rows. Use explicit profile IDs resolved
during environment setup; do not match mutable display names in application
code. A whole-day rule has both time columns null. A time-bounded rule covers a
half-open local interval, and weekdays use ISO values 1 (Monday) through 7
(Sunday):

```sql
insert into private.pricing_rules
  (teacher_id, weekdays, start_time, end_time, hourly_rate, priority, label, active)
values
  (null, array[1,2,3,4,5]::smallint[], '08:30', '17:00', 10.00, 0,
   'Standard weekday daytime', true);
```

Before changing a rule, inspect the complete active configuration as the owner:

```sql
select id, teacher_id, weekdays, start_time, end_time,
       hourly_rate, priority, label, active
from private.pricing_rules
where active
order by teacher_id nulls first, weekdays, start_time nulls first, priority desc, id;
```

Keep coverage unambiguous at the winning precedence and priority for every
bookable segment. Do not grant browser access to `private.pricing_rules` or
accept a browser-calculated amount. The quote and mutation RPCs perform the
same server-side matching and snapshot the result transactionally.

## Authorized monthly reports and CSV/print output

The browser report screens call these exact authenticated RPCs:

- `get_my_month_report(month)` returns only the current teacher's authorized
  rows, reservation/cancellation counts, snapshot breakdowns, and the active
  rows' total due.
- `get_admin_month_report(month, teacher_id nullable)` requires an administrator
  and returns authorized rows, per-teacher totals, and the combined cashbox
  total. A null teacher selects all teachers.

The month is a calendar date such as `date '2026-09-01'`; filtering compares the
local booking date directly. The report's effective amount is the stored
`calculated_amount` for an active booking and zero for a cancelled booking.
The application provides browser print CSS and client-side CSV export of exactly
the authorized rows returned by these RPCs. It does not generate server-side
PDF/CSV files or expose hidden booking fields.

For an owner-side snapshot reconciliation, use a read-only query with a
start-inclusive/end-exclusive local-month window. This mirrors the report
calculation and uses stored snapshots; it does not recalculate historical prices:

```sql
select b.teacher_id,
       b.starts_at::date as booking_date,
       count(*) as reservation_count,
       count(*) filter (where b.cancelled_at is not null) as cancelled_count,
       coalesce(sum(case when b.cancelled_at is null
                         then b.calculated_amount else 0 end), 0)::numeric(12,2)
         as effective_amount_due
from public.bookings b
where b.starts_at >= :month_start::date::timestamp
  and b.starts_at <  (:month_start::date + interval '1 month')::timestamp
group by b.teacher_id, b.starts_at::date
order by b.teacher_id, booking_date;
```

Use the authorized application report for teacher/admin viewing and export.
Direct owner queries and Table Editor exports are administrative diagnostics,
not a substitute for the RLS-scoped browser report.

## Cancellation and booking operations

Use the application controls, which call `cancel_booking(id, expected_version,
scope)` with `scope` `one` or `future`. The database rechecks ownership,
version, series order, and active status. Never delete a booking to represent a
cancellation: the retained row and snapshot are needed for reporting and audit.

Booking creation and editing call `quote_booking`, `create_booking_series`, or
`edit_booking`; each authoritative mutation recalculates pricing and stores a
fresh snapshot. A quote is display-only and cannot authorize or fix an amount.

## Backups and paused projects

Before a risky administrative change, an owner may export the `public` and
`private` schemas with `pg_dump` or the Supabase CLI. Keep the result outside the
repository and protect it as sensitive data:

```bash
pg_dump --dbname "$SUPABASE_DB_URL" --schema=public --schema=private \
  --no-owner --no-acl > backup-$(date -I).sql
```

To restore a paused Supabase Free project, open the project in the Supabase
Dashboard, select Resume, wait for project health checks, and then verify the
application can load a schedule. Plan limits and backup availability must be
checked against the current Supabase plan; no scheduled keep-alive is part of
this application.

## Operational verification commands

Run from the repository root. These are the package scripts currently defined
by `package.json`:

```bash
npm run typecheck
npm run test:unit
SUPABASE_DB_URL=... npm run test:db
npm run test:e2e
npm run build
npm run test:pwa
npm run check:public-build
npm run auth:smoke
```

The final release gate must include an integrated browser/database verification
using a disposable synthetic admin and teacher setup. Verify native-session
access, profile deactivation, RLS privacy, local 30-minute booking validation,
pricing snapshots, cancellation effective amount, teacher/admin report scope,
browser print/CSV authorization, security headers, static manifest, and absence
of a service worker. Record the exact commands and outputs in the release
checklist; do not mark a gate passed from an unrun check.
