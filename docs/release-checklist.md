# Release checklist

This checklist is the release handoff for the native-session Class Scheduler.
It separates evidence actually collected from gates that remain deferred. A
checkbox is checked only when the command or review named beside it was run.

## Release identity

- Application: `class-scheduler`
- Supabase project ref: `gywnhwgimmtanzvpxwoo`
- Netlify site: `https://class-admin.netlify.app`
- Migration: `supabase/migrations/20260913000100_v1.sql`
- Database model: `public.profiles`, `public.classes`, `public.bookings`, and
  the private singleton `private.room_rate`.
- Authentication model: a reusable personal `/access#<token>` link establishes a
  native Supabase session. The browser and installed PWA use the native
  session; RLS resolves `auth.uid()`.

## Verified local evidence

Run from the repository root. The exact output for each command is recorded in
this task handoff and must be refreshed after a source change.

- [x] `docker version --format '{{.Server.Version}}'` returned `29.8.0`.
- [x] `supabase db reset --local` completed and applied the migration and seed.
- [x] `SUPABASE_DB_URL=... npm run test:db` — `Test Files  8 passed (8)`;
      `Tests  89 passed (89)`; exit 0.
- [x] `npm run typecheck` — exit 0.
- [x] `npm run test:unit` — `Test Files  11 passed (11)`;
      `Tests  68 passed (68)`; exit 0.
- [x] `npm run test:e2e` — Chromium and WebKit, 390x844; `8 passed (5.3s)`.
- [x] `npm run build` — Vite 8.3.0 built 66 modules; Workbox precache 6
      entries (252.58 KiB); public-build safety passed.
- [x] `npm run test:pwa` — Chromium and WebKit 390x844 PWA shell, cache
      isolation, and offline launch passed.
- [x] `npm run check:public-build` — `Build looks safe (no detected static
      secrets)`; exit 0.
- [x] `npm run auth:smoke` — native session exchange, reusable token, RLS
      owner write, cross-teacher denial, and deactivation revocation all
      printed `PASS`; exit 0.
- [x] `git diff --check` — no output; exit 0.

The database rate check is part of the DB suite. `private.room_rate` must have
one row with a non-negative `room_hour_rate` and a three-letter uppercase
`currency`. The billing report multiplies uncancelled hours by this current
rate, includes the currency and money total, and reports cancelled hours
separately. If the rate preflight returns `missing_current_room_rate`, stop;
never interpret an empty report as a zero rate.

## Supabase owner operations

### Profiles and links

Run profile administration in the Supabase SQL Editor as the owner role. The
application has no profile-admin UI or API.

```sql
insert into public.profiles (name, role) values ('Teacher name', 'teacher');
select private.issue_access_link('<profile-uuid>');
```

Copy the returned token once into a private link as
`https://class-admin.netlify.app/access#<token>`. Do not paste real tokens into
SQL history shared with the team, source files, logs, tickets, or chat.

To revoke a teacher:

```sql
update public.profiles set active = false where id = '<profile-uuid>';
```

To replace a link, issue a new link for the active profile. Reactivating a
Reactivating a profile does not revive its superseded or revoked link:

```sql
update public.profiles set active = true where id = '<profile-uuid>';
select private.issue_access_link('<profile-uuid>');
```

### Current room rate

There is one current rate, stored in `private.room_rate`; there is no year
column and no annual-rate history. Update it with:

```sql
insert into private.room_rate (room_hour_rate, currency)
values (20.00, 'BGN')
on conflict (singleton) do update set room_hour_rate = excluded.room_hour_rate,
  currency = excluded.currency;
```

Before billing, run:

```sql
select case when count(*) = 1 then 'current_rate_ready'
            else 'missing_current_room_rate' end as status
from private.room_rate;
```

### Monthly billing, cancellation report, and export

Use the parameterized SQL in `docs/operations.md` with a local-Sofia,
start-inclusive/end-exclusive window. The current rate is used for every
booking date. Cancelled bookings are nonbillable and are reported separately.
The same document contains the CSV-compatible booking export. Supabase Table
Editor or the SQL Editor is the reporting surface; the app has no billing or
export screen.

### Restore a paused Free project

In Supabase Dashboard, open the project and select **Resume** on the paused
project banner. Wait for the project health checks to complete, then verify
that the app can load a schedule. Free-plan backup and pause limits are subject
to the current Supabase plan and must be rechecked before production use.

### Backup/export responsibility

Before a risky operational change, the administrator exports the public and
private schemas with `pg_dump` or the Supabase CLI. Store the resulting backup
outside the repository and protect it as sensitive data. No scheduled
keep-alive or application export endpoint is provided.

## Deployment and security gates

- [ ] Owner-authorized deployment to the named Netlify site only.
- [ ] Production response headers read back: CSP, `Referrer-Policy:
      no-referrer`, `X-Content-Type-Options: nosniff`, and private/no-store
      headers for the access response.
- [ ] Production check used only disposable synthetic profiles and bookings;
      all such data was removed or the profiles were deactivated afterward.
- [ ] Production build contains only public Vite variables; function secrets
      are not prefixed `VITE_` and are not present in previews.
- [ ] Supabase migration was applied through the owner's approved database
      deployment process; frontend builds do not run migrations.

The imported ES256 signing-key design, custom JWT/JWKS configuration, and
signing-key rotation gate are cancelled by the approved native-session
revision. There is no signing key to import, recover, or rotate for this
application. Native Supabase session revocation and profile deactivation are
the applicable access-revocation controls.

## PWA verification matrix

| Gate | Evidence/status |
|---|---|
| Phone-first layout at 390x844 | Playwright Chromium/WebKit emulation; record `npm run test:e2e` output. |
| Credential-free manifest and public-only service-worker cache | `npm run test:pwa`; record exact output. |
| Offline launch | Browser emulation shows connectivity guidance and disables writes; no stale availability claim. |
| Android Chrome installed launch | Physical-device check deferred to the owner; not claimed here. |
| iPhone Safari installed launch | Physical-device check deferred to the owner; not claimed here. |
| Link replacement after rotation | Opening the replacement link is supported; any already-installed app using old persisted state must be reauthenticated/reinstalled as needed. |

Physical Android/iPhone installation, close/relaunch, storage separation, and
OS-specific Add to Home Screen behavior are explicitly deferred owner checks.
Browser-emulated tests are not physical-device evidence.

## Final sign-off

Do not declare V1 released while a required local test, independent review,
authorized hosted check, or the owner-deferred device check is represented as
passed without evidence. Record the final commit hash and exact command output
in the task handoff; keep secrets, tokens, and database dumps out of git.
