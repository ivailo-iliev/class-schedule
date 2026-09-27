# Release checklist

This checklist is the release handoff for the native-session Class Scheduler.
A checkbox is checked only when the command, review, or hosted verification
named beside it was actually completed. Unchecked items are release gates, not
claims of failure.

## Release identity

- Application: `class-scheduler`
- Supabase project ref: record the approved target in the private deployment
  handoff; do not commit a production identifier here.
- Netlify site: record the approved target in the private deployment handoff;
  use a placeholder when sharing this checklist.
- Migration baseline: `supabase/migrations/20260913000100_v1.sql`
- Database model: `public.profiles`, `public.classes`,
  `public.bookings`, and owner-managed `private.pricing_rules`.
- Booking times: local `timestamp without time zone` wall-clock values on one
  calendar date, in 30-minute boundaries. Audit fields are instants.
- Pricing: EUR rules are selected by trusted database code and snapshotted per
  booking in `currency`, `calculated_amount`, and `price_breakdown`.
- Authentication: a reusable fragment link at `https://<site-origin>/#<token>`
  is exchanged through `/api/access` for a native Supabase session. RLS binds
  data access to the active profile.
- PWA/deployment: static manifest and icons, no service worker or offline cache;
  `/api/access` is the only application function route.

## Evidence status

Run commands from the repository root. This docs-only change did not run source,
database, browser, or hosted deployment checks. Refresh each unchecked result
with the exact output before release; do not copy output from an earlier code
revision.

### Focused documentation checks completed for this revision

- [x] `git diff --check` — run after editing these two documents; no whitespace
      errors were reported.
- [x] Documentation reference audit — checked that both documents use the
      current RPC names, local timestamp model, EUR snapshot fields, fragment
      link, `/api/access`, static manifest/no-service-worker model, and current
      `package.json` script names; no obsolete billing or route references
      remain.
- [x] Markdown rendering review — reviewed headings, tables, fenced SQL/bash
      blocks, inline code, and links in both updated documents.

### Local and integration checks to run for the release candidate

- [ ] `npm run typecheck` — record the actual exit status and output.
- [ ] `npm run test:unit` — record the actual Vitest summary.
- [ ] `SUPABASE_DB_URL=... npm run test:db` — record the actual database test
      summary, including pricing, snapshot, cancellation, report, and RLS
      assertions.
- [ ] `npm run test:e2e` — record the actual Chromium/WebKit phone-flow result.
- [ ] `npm run build` — verify the static manifest and public assets are built.
- [ ] `npm run test:pwa` — verify the static manifest and absence of a service
      worker/cache.
- [ ] `npm run check:public-build` — record the actual public-build secret scan.
- [ ] `npm run auth:smoke` — record native-session exchange, reusable fragment
      access, RLS owner write, cross-teacher denial, and deactivation behavior.
- [ ] `git status --short` and `git diff --check` — confirm only intentional
      files and no credentials, tokens, dumps, or generated secrets are present.

## Supabase owner setup

Profiles and pricing are administered by an owner in Supabase, not by an
application administration screen. Use only synthetic names and placeholders in
shared evidence:

```sql
insert into public.profiles (name, role)
values ('Teacher name', 'teacher');

select private.issue_access_link('<active-profile-uuid>');
```

Distribute the returned raw token only as `https://<site-origin>/#<token>`.
Never place a real token, profile ID, project ref, or credential in this file,
a ticket, chat, CI output, or a committed fixture. Deactivate an account with:

```sql
update public.profiles
set active = false
where id = '<active-profile-uuid>';
```

Reactivation requires issuing a new link. The `/api/access` function creates or
restores the native session and the browser clears the fragment after exchange.

Pricing rules are owner-managed in `private.pricing_rules`. Verify the active
configuration before release and ensure every bookable segment has exactly one
winning rule at its precedence and priority. Do not grant browser access to the
private pricing schema or add pricing/profile management UI.

```sql
select id, teacher_id, weekdays, start_time, end_time,
       hourly_rate, priority, label, active
from private.pricing_rules
where active
order by teacher_id nulls first, weekdays, start_time nulls first, priority desc, id;
```

## Reports, snapshots, and cancellation gates

- [ ] A teacher can call `get_my_month_report(month)` only for their own
      authorized rows. Verify reservation/cancellation counts, local calendar
      month filtering, stored `calculated_amount`/`price_breakdown`, and active
      total due.
- [ ] An administrator can call `get_admin_month_report(month, teacher_id)`
      for all teachers or one selected teacher. Verify per-teacher totals and
      the combined cashbox total.
- [ ] A cancelled booking retains its original EUR snapshot and appears in an
      authorized report with effective amount due equal to EUR 0.
- [ ] Browser print and client-side CSV export contain exactly the authorized
      report rows returned by the RPC; no hidden student, price, or other
      teacher data is exposed.
- [ ] Quote/create/edit mutation checks use trusted pricing rules and store the
      server-calculated snapshot. A later rule edit does not rewrite an existing
      untouched booking.
- [ ] Local booking boundaries, same-date validation, room/teacher overlap
      handling, recurring series, and cancellation scopes pass the database and
      browser tests.

The final reports are usage totals derived from booking snapshots. They are not
payments, balances, settlements, invoices, or a ledger.

## Deployment and security gates

- [ ] Owner-authorized deployment targets only the approved Netlify site and
      Supabase project; record targets privately rather than in this checklist.
- [ ] Production response headers read back as CSP,
      `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and
      private/no-store for `/api/access`.
- [ ] Production checks use only disposable synthetic profiles/bookings; remove
      the data or deactivate the profiles afterward.
- [ ] The production build contains only public Vite variables. Function secret
      variables are not prefixed `VITE_` and are absent from deploy previews.
- [ ] The migration is applied through the owner's approved Supabase deployment
      process; frontend builds do not run migrations.
- [ ] `npm run check:public-build` and the built-asset review find no credential,
      access-token, or private configuration material.

The cancelled custom signing-key/JWKS design is not part of this release. Native
Supabase session revocation and active-profile checks are the applicable access
controls.

## PWA and hosted verification matrix

| Gate | Evidence/status |
|---|---|
| Phone-first layout at 390x844 | Deferred until the release candidate; run `npm run test:e2e` and record exact output. |
| Static manifest and no service-worker cache | Deferred until the release candidate; run `npm run test:pwa` and record exact output. |
| Offline behavior | Not supported; reconnect before using the network-backed app. |
| Android Chrome installed launch | Physical-device owner check deferred; browser emulation is not physical-device evidence. |
| iPhone Safari installed launch | Physical-device owner check deferred; browser emulation is not physical-device evidence. |
| Fragment-link reuse and rotation | Integrated browser/DB gate below; record both old-link rejection after rotation and native-session persistence. |
| Production security headers and access rate limit | Hosted owner check deferred; record read-back responses and the approved test evidence. |

## Integrated final browser/database gate

- [ ] Run the final integrated verification against a disposable Supabase project
      and authorized preview/production candidate. Cover two clean browsers,
      reusable fragment-link exchange, native-session restoration, link rotation,
      deactivation, teacher/admin RLS boundaries, local wall-clock dates,
      pricing quote and immutable snapshot, cancellation effective amount,
      monthly report scope/totals, browser print/CSV output, security headers,
      static manifest, and no service worker.
- [ ] Record exact commands, commit SHA, target environment, test summaries,
      and hosted read-back evidence in the release handoff. Do not claim this
      gate passed until that evidence exists.

## Final sign-off

Do not declare V1 released while a required local test, independent review,
authorized hosted check, or owner-deferred physical-device check is represented
as passed without evidence. Record the final commit hash and exact command output
in the private release handoff; keep secrets, tokens, profile identifiers, and
database dumps out of git.
