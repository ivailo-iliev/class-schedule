# Class Scheduler V2 — Simplified Clean Rewrite

**Status:** APPROVED — ready for implementation

**Updated:** 2026-09-16

**Authority:** This is the current V2 implementation plan. It replaces the earlier version of this document and supersedes older V1 plans where they conflict.

## 1. Goal

Replace the experimental app with a small, phone-friendly internal scheduler:

- Teachers view the daily schedule for two rooms and add confirmed one-hour bookings.
- A booking can be created once or as a batch of concrete recurring dates.
- Teachers can cancel one booking or the selected booking and future bookings from its batch.
- Cancelled records remain available for internal room-usage billing.
- Teachers sign in with a six-digit email code and normally remain signed in on that device.
- The app can be added to a home screen, but always requires a network connection.

This is a clean rewrite. There is no production data to migrate and no compatibility layer to preserve.

## 2. Architecture

- Build a static SPA with **Svelte, Vite, and TypeScript**. Do not use React or SvelteKit.
- Host the compiled assets on the existing free Netlify site.
- Use `@supabase/supabase-js` directly from the browser for authentication and permitted database reads/writes.
- Use **no Netlify Functions** and no application server.
- Keep state local to a few components: login, schedule, and booking dialog. Do not add a router or global state library.
- Add a static `manifest.webmanifest`, icons, theme metadata, `start_url: "/"`, `scope: "/"`, and `display: "standalone"`.
- Do not add a service worker, offline storage, cached schedules, background sync, or a custom install flow.

## 3. Authentication

Use native **Supabase email OTP** with a six-digit code, not a clickable magic link.

### Teacher provisioning and login

1. The administrator adds the teacher's `name`, normalized `email`, and `active` state to `public.teachers` using Supabase's Table Editor or SQL Editor.
2. The teacher enters that email in the app.
3. Supabase sends a six-digit OTP.
4. The teacher enters the code and Supabase creates a normal persistent session. The first successful OTP may also create the managed Supabase Auth user.
5. RLS grants application access only when the verified email in the JWT matches an active teacher row.

An authenticated email that is not in the active teacher allowlist receives no application data. Deactivating the teacher row blocks the session on its next database request.

### Email delivery

- Configure Supabase custom SMTP with a dedicated free Gmail account initially.
- Use `smtp.gmail.com` on port `587`, the Gmail address as the username/sender, and a Google App Password stored only in Supabase configuration.
- Enable two-step verification on that Gmail account before creating the App Password.
- Change the Supabase email template to display `{{ .Token }}` as the login code rather than linking through `{{ .ConfirmationURL }}`.
- Do not commit SMTP credentials or expose them through Vite environment variables.

Do not build custom access links or tokens, password creation/recovery, OAuth or another external identity provider, signup/account-management screens, hidden Auth-user exchange, or an authentication API.

## 4. Minimal data model

Supabase's managed Auth tables are not application tables.

### `public.teachers`

| Column | Rule |
|---|---|
| `id` | database-generated UUID primary key |
| `email` | required, normalized, case-insensitively unique |
| `name` | required, nonblank text |
| `active` | boolean, default `true` |
| `created_at` | timestamp, default `now()` |

There are no roles or per-teacher rates. The email is the link between the Supabase session and the teacher record; no `auth_user_id` binding is needed.

### `public.bookings`

| Column | Rule |
|---|---|
| `id` | database-generated UUID primary key |
| `batch_id` | required UUID shared by one creation action |
| `teacher_id` | required reference to `teachers.id` |
| `title` | required trimmed free text, maximum 200 characters |
| `details` | optional text, maximum 1,000 characters; may contain a child's name |
| `room` | integer, Room 1 or Room 2 |
| `booking_date` | local calendar date |
| `hour` | whole-hour start from 08 through 21 |
| `cancelled_at` | nullable timestamp; null means active |
| `created_at` | timestamp, default `now()` |

Each row is exactly one hour. Add partial unique indexes for active rows:

```text
(room, booking_date, hour) where cancelled_at is null
(teacher_id, booking_date, hour) where cancelled_at is null
```

These indexes are the final authority for concurrent room and teacher conflicts. Cancelled rows remain stored but free both slots.

### `private.room_rate`

Keep one private singleton configuration row:

| Column | Rule |
|---|---|
| `singleton` | boolean primary key constrained to `true` |
| `hourly_rate` | nonnegative `numeric(10,2)` |
| `currency` | three-character currency code |
| `updated_at` | timestamp, default `now()` |

This is the hourly charge for **room usage**, never teacher pay. Only an administrator/service role can read or change it.

## 5. Authorization and direct data operations

Use RLS and narrow column grants. An active teacher is resolved by case-insensitive comparison of `auth.jwt() ->> 'email'` with `teachers.email`.

- Active teachers can read active booking rows and the `id`/`name` of active teachers.
- A teacher can insert bookings only with their own `teacher_id`.
- A teacher can update only the `cancelled_at` column of their own bookings.
- Teachers cannot delete bookings or read the room-rate table.
- Inactive or unknown authenticated users cannot read or mutate app data.

Use direct Supabase operations; do not add booking RPCs or security-definer functions:

- **Create:** generate one `batch_id` in the browser and send all concrete booking rows in one `insert([...])` request. PostgreSQL executes the multi-row insert atomically; if either unique index reports a conflict, no row in the batch is created.
- **Cancel one:** update `cancelled_at` for the selected owned booking ID when it is still null.
- **Cancel selected and future:** issue one update for active owned rows with the same `batch_id` and `booking_date` on or after the selected date. Every batch uses one fixed hour, so date ordering defines “future” within it.
- **Correct mistakes:** cancel and recreate; there is no edit or reschedule operation.

The client validates title/details lengths, rooms, hours, nonempty unique dates, recurrence limits, and past dates before writing. RLS protects ownership and database constraints protect referential integrity and scheduling conflicts.

### Lesson-details privacy boundary

The normal schedule query omits `details`, and the frontend fetches/displays details only when the selected booking belongs to the signed-in teacher. This is deliberate **UX filtering, not a database confidentiality boundary** in the teacher-only V2: another authenticated teacher capable of making raw Supabase requests could request that column.

If parent access is later implemented, expose a restricted parent-facing view or API that never returns lesson details. Do not pre-build that layer now.

## 6. Client behavior

### Login and session

- Show an email field, “Send code”, a six-digit code field, and “Verify”.
- Use Supabase's persistent browser session; a valid session opens the schedule directly after reload.
- Provide sign out and clear client state when authorization fails.
- After verification, show “Access not granted” when no active matching teacher exists.

### Daily schedule

- Default to today in `Europe/Sofia`; support previous/next day and direct date selection.
- Show Room 1 and Room 2 with hourly slots from 08:00 through 21:00.
- Display each active booking's title and teacher name, never its details in the grid.
- Distinguish a failed fetch from an empty day so unavailable data is never shown as free rooms.
- Refresh after successful creation or cancellation; do not add realtime, polling, or client caching in V2.

### Booking creation

- Clicking an empty slot opens a dialog prefilled with date, room, and hour.
- `title` is free text with a native `datalist` built from the signed-in teacher's recent distinct titles. There is no classes table or class-management UI.
- `details` is optional and may hold the child name or practical notes.
- One-off creation inserts one row with one new batch ID.
- Recurring creation chooses a Monday-based starting week, one or more weekdays, and 1–52 weeks. The browser materializes and previews the concrete dates, with a maximum of 104 rows, then submits them as one batch.
- A later creation is always a new batch, even when its title or pattern matches an earlier batch.

### Cancellation

- The booking owner can choose “Cancel this booking”.
- When the batch has a later active row, also offer “Cancel this and future bookings”.
- Confirm the selected scope before the direct update.
- Other teachers can see that the slot is occupied but receive no cancellation controls.

## 7. Billing

Billing remains an administrator-only SQL/reporting task; there is no billing UI.

- One active booking row equals one billable room hour.
- For a requested month, group active booking hours by teacher and multiply each count by the single current `private.room_rate.hourly_rate`.
- Report cancelled hours separately and exclude them from the default billable amount.
- Use the current rate retroactively; do not snapshot a rate on each booking.
- If the singleton rate is missing, report “rate not configured” rather than calculating zero.

## 8. Explicit non-goals

- Parent accounts, enrollment, notifications, or parent-facing schedule access.
- Teacher availability, booking requests, or approval workflows. Individual lessons are confirmed offline and then entered as bookings.
- Payments, invoices, teacher compensation, or online payment collection.
- Attendance tracking.
- A classes/modules table; group modules, trials, and individual lessons are represented by booking titles.
- Recurrence definitions or a background recurrence engine.
- Offline operation or cached availability.
- Admin/profile/billing UI, audit framework, generic roles, or configurable rooms.

## 9. Implementation sequence

1. Replace the experimental schema with the three small tables, constraints, grants, RLS policies, and administrator billing query; regenerate TypeScript database types.
2. Configure Supabase email OTP and Gmail SMTP outside the repository, including the six-digit-code template.
3. Replace the React client with the Svelte/Vite/TypeScript SPA and native Supabase session bootstrap.
4. Implement the daily schedule, direct atomic booking creation, recurrence preview, owner details, and both cancellation scopes.
5. Add the static manifest/icons and responsive, accessible styling.
6. Remove obsolete functions, custom-access code, React dependencies, and unused schema. Verify that no secret is present in source or built assets.

Implementation tasks start from committed state, use their own worktree/branch, and receive independent review as required by `AGENTS.md`.

## 10. Acceptance tests

### Authentication and authorization

- Email OTP sends and verifies a six-digit code through the configured Gmail SMTP account; the session survives reload.
- A known active email can use the app; an unknown or inactive email cannot read or mutate application data.
- Deactivation blocks an already authenticated teacher on the next database request.
- Teachers cannot create bookings for another teacher, cancel another teacher's booking, delete rows, or read the room rate.
- No SMTP secret, service key, custom access token, or raw credential appears in the browser bundle or logs.

### Scheduling and cancellation

- One-off creation inserts one row; recurring creation inserts exactly the previewed dates with one shared batch ID.
- A batch insert is all-or-nothing when one requested slot conflicts.
- Concurrent attempts for the same room/time or teacher/time produce one winner through the unique indexes.
- Cancelling one affects only the selected row; cancelling future affects the selected and later active rows only in that batch.
- Cancellation frees the room and teacher slot, retains the cancelled row, and the correction flow is cancel/recreate.
- The normal schedule omits lesson details; the owner UI shows them only on demand. Tests and documentation acknowledge that this is not confidentiality against raw API use by another teacher.

### UI, recurrence, billing, and installability

- The two-room 08:00–21:00 grid works on phone and desktop, and failures are not rendered as free slots.
- Recurrence handles multiple weekdays, year boundaries, 52 weeks, and the 104-row limit using Sofia calendar dates rather than UTC duration arithmetic.
- Monthly billing counts active one-hour rows times the global room rate, reports cancelled hours separately, and fails clearly when the rate is absent.
- The manifest and icons validate, installed display mode is standalone, and no service worker or offline cache is registered.
- Type checking, unit/component tests, database integration tests, production build, secret scan, and a manual two-teacher conflict/cancellation smoke test pass.

## 11. Fixed assumptions

- The timezone is `Europe/Sofia`.
- There are exactly two rooms.
- Starts are whole hours from 08:00 through 21:00 and every booking lasts one hour.
- Group modules and free trials are distinguished by title; attendance and payment are handled offline.
- Individual lessons are confirmed offline and may identify the child in `details`.
- Every create action forms an independent batch with one fixed room and hour.
- Cancellation history is retained for internal room billing.
- The single current room rate applies retroactively; cancelled hours are nonbillable by default.
- There is no production data to migrate or backfill.
