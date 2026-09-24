# Class Scheduler — Targeted Refactor Plan

**Status:** APPROVED — ready for implementation

**Updated:** 2026-09-17

**Authority:** This is the authoritative implementation plan. It supersedes `plans/class-scheduler-v2/implementation-plan.md`, which proposed a clean rewrite. The existing application is not in production, so implementation may replace the baseline schema and does not need data migration or backward compatibility.

## 1. Goal

Refactor the existing internal scheduler into a simple two-room reservation and room-usage reporting application:

- Teachers reserve `Зала` or `Стая` for one or more consecutive 30-minute intervals.
- Teachers see the calculated room price before confirming a reservation.
- The database snapshots the applied price so later pricing-rule changes do not rewrite history.
- Teachers see their own monthly reservation report and amount due.
- Administrators see all teacher reports, per-teacher totals, and the combined cashbox total.
- Recurring reservations remain concrete booking rows that can be changed or cancelled individually or from one occurrence forward.
- Personal access links are reusable, while native Supabase sessions keep a device signed in.

This is usage reporting, not a financial wallet. The app does not record payments, credits, settlements, or account balances.

## 2. Architecture: retain and remove

### Retain

- React 19, Vite, TypeScript, `@supabase/supabase-js`, Vitest, Testing Library, and Playwright.
- The current `App`, schedule, booking form/details, classes, session, API, and test foundations; reshape them rather than rebuilding in another framework.
- Supabase Postgres, native Supabase Auth sessions, RLS, and database RPCs for atomic operations.
- `profiles` with `teacher` and `admin` roles.
- `classes` as teacher-owned reusable activity-title templates.
- `bookings`, cancellation history, optimistic versioning where useful, concrete recurrence rows, and server-authoritative conflict checks.
- Netlify static hosting and one Netlify access function.

### Remove or simplify

- Do not migrate to Svelte and do not replace the current component/test stack.
- Remove one-time access-token consumption, `access_token_used_at`, `consume_access`, and credential-version machinery associated with automatic revocation.
- Remove the profile function after session restoration reads the safe profile projection directly through RLS.
- Remove the health function unless deployment infrastructure has an independently documented consumer; none is part of this app plan.
- Replace the dynamic/private manifest function and install cookie with a public static manifest and icons.
- Remove UTC/Sofia conversion, DST-gap/fold detection, and timezone-specific slot-resolution code.
- Replace the singleton room-rate table and its reports with editable pricing rules and price snapshots.

Keep secrets in Netlify/Supabase environment configuration. Never expose or commit a Supabase secret/service key.

## 3. Authentication and profile administration

### Reusable personal links

- Keep a 32-byte random personal token encoded as 64 lowercase hexadecimal characters.
- Put the raw token only in the URL fragment, for example `https://site.netlify.app/#<token>`. Fragments are not sent in preview HTTP requests.
- Store only the SHA-256 token hash in `profiles.access_token_hash`.
- The browser sends the fragment token to the existing `/api/access` Netlify function. The function validates origin, method, body size, format, rate limit, and the active profile; creates the hidden Supabase Auth user when missing; and returns a native Supabase session.
- Do not consume the token. The same valid link can establish sessions on multiple devices or be reopened after a messaging-app preview.
- When a fragment is present, exchange it even if another native session already exists on the device. Without a fragment, restore the persisted native session.
- Clear the fragment from the visible browser URL after exchange. Supabase persists and refreshes the returned session normally.
- The access response and all authentication responses use `Cache-Control: no-store` and never log the raw token or returned session credentials.

### Revocation semantics

- Generating a replacement token in Supabase invalidates the old link for future exchanges but does not sign out already established native sessions.
- Deactivating a profile clears its stored access-token hash and immediately blocks that profile through the active-profile checks used by every RLS policy/RPC, including already established sessions.
- Reactivating a profile requires issuing a new link.
- Keep `auth_user_id` stable when rotating links or deactivating/reactivating a profile.

### Administration

- Administrators manage all profiles through the Supabase dashboard/SQL, not an in-app screen.
- Guest teachers are ordinary `teacher` profiles and default to the standard pricing rules.
- Access-link issuance/rotation remains a restricted SQL function used from Supabase administration. There is no email/password, email OTP, external identity provider, signup, password reset, or account-management flow.

## 4. Data model

Replace the experimental baseline schema directly because no production data must be retained. Regenerate TypeScript database types after the schema settles.

### `public.profiles`

Keep:

- `id`, `name`, `role`, `active`, `access_token_hash`, `auth_user_id`.
- `created_at` and `updated_at` audit instants.

Remove `access_token_used_at` and `credential_version`. Profile names remain visible to authenticated active profiles; credential fields never receive browser grants.

### `public.classes`

Keep the current lightweight model:

- `id`, `teacher_id`, `name`, `active`, and created/updated audit metadata.
- A teacher manages only their own titles; an administrator may manage titles for any teacher.
- Archiving a class prevents new bookings but does not change existing bookings or reports.

Classes are title templates only. Do not add modules, enrollment, attendance, course pricing, or student membership.

### `public.bookings`

Use these business fields:

| Field | Rule |
|---|---|
| `id` | UUID primary key |
| `series_id` | UUID shared by all rows created in one one-off/recurring action |
| `series_index` | Zero-based immutable order within the series; unique with `series_id` |
| `teacher_id` | Server-derived from the selected class and immutable |
| `class_id` | Active reusable activity title owned by `teacher_id` |
| `room` | Enum value `hall` (`Зала`) or `room` (`Стая`) |
| `starts_at` | Local `timestamp without time zone` |
| `ends_at` | Local `timestamp without time zone` |
| `student_details` | Optional trimmed private text, maximum 1,000 characters |
| `currency` | Snapshot value `EUR` |
| `calculated_amount` | Nonnegative `numeric(12,2)` snapshot |
| `price_breakdown` | JSONB snapshot of segment start/end, rule ID/label, hourly rate, and segment subtotal |
| `cancelled_at`, `cancelled_by` | Nullable cancellation audit data |
| audit/version fields | `created_at/by`, `updated_at/by`, and positive `version` |

Rules:

- `starts_at` and `ends_at` are wall-clock values for the single Sofia facility. Audit timestamps remain `timestamptz` instants.
- Start/end seconds and fractions must be zero and minutes must be `00` or `30`.
- `ends_at > starts_at`; both values must be on the same local calendar date.
- A booking may span any positive number of consecutive 30-minute segments for which pricing is configured.
- Teachers may book only their own active classes. Administrators may create/manage a booking for any active teacher by selecting one of that teacher's active classes.
- `teacher_id`, price, and price breakdown are set by trusted database code, never accepted from browser-calculated values.
- Cancelled rows and their snapshots are immutable except for audit maintenance and remain available to reports.

Enable `btree_gist` and add partial exclusion constraints for active half-open ranges `[starts_at, ends_at)`:

```sql
exclude using gist (room with =, tsrange(starts_at, ends_at, '[)') with &&)
where (cancelled_at is null)

exclude using gist (teacher_id with =, tsrange(starts_at, ends_at, '[)') with &&)
where (cancelled_at is null)
```

Therefore adjacent reservations are allowed, but any partial overlap is rejected. Two teachers may reserve different rooms at the same time; one teacher may not occupy both rooms at once.

### `private.pricing_rules`

Replace `private.room_rate` with one configuration table managed only through Supabase:

| Field | Rule |
|---|---|
| `id` | UUID primary key |
| `teacher_id` | Nullable profile reference; null means the standard tariff |
| `weekdays` | Nonempty ISO weekday array (`1` Monday through `7` Sunday) |
| `start_time`, `end_time` | Both null for a whole-day teacher rate, otherwise a valid half-open local interval |
| `hourly_rate` | Nonnegative `numeric(12,2)` in EUR |
| `priority` | Integer used to resolve intentional rules at the same specificity |
| `label` | Required human-readable snapshot label |
| `active` | Whether the rule can price new/edited bookings |
| audit fields | Created/updated timestamps |

Pricing is the same for `Зала` and `Стая`, so room is not a rule dimension. Do not add a pricing-management UI.

## 5. Pricing engine

### Matching and precedence

Split every occurrence into 30-minute segments and choose exactly one rule for each segment in this order:

1. An active, time-bounded rule for the booking's teacher, weekday, and full segment.
2. An active whole-day rule for the booking's teacher and weekday.
3. An active standard rule (`teacher_id is null`) for the weekday and full segment.

Within the same level, choose the greatest `priority`. If no rule matches, or multiple rules tie at the winning level/priority, reject the quote and mutation with a configuration error; never assume zero.

For each segment:

```text
segment subtotal = hourly rate / 2
reservation amount = sum of segment subtotals
```

Round/store monetary values to two decimals. The database is authoritative. Browser calculations are display-only.

### Initial rules

Seed the following standard rules:

| Days | Time | Rate |
|---|---|---:|
| Monday–Friday | 08:30–17:00 | €10/hour |
| Monday–Friday | 17:00–20:00 | €25/hour |
| Saturday–Sunday | 09:00–13:00 | €30/hour |
| Saturday–Sunday | 13:00–15:00 | €10/hour |
| Saturday–Sunday | 15:00–19:00 | €30/hour |

Seed whole-day €10/hour teacher rules for Елеонора, Силвия, and Мария Бакалова. Resolve these profiles by explicit IDs during environment setup rather than matching mutable display names in runtime code.

Seed higher-precedence €0/hour rules for Елеонора:

- Monday–Thursday, 13:30–16:00 — `Занималня`.
- Monday–Thursday, 17:30–19:30 — `Предучилищна/подготовка за първи клас`.

These zero-price rules match teacher and time, not activity-title spelling. Friday and all other Елеонора segments fall back to her fixed €10/hour rule. Галя, guest teachers, and future teachers without a specific rule use the standard tariff.

### Quote and snapshot contract

Expose authenticated RPCs with JSON-compatible inputs/outputs:

- `quote_booking(class_id, room, occurrences[])` accepts 1–104 unique `{starts_at, ends_at}` local occurrences, verifies actor/class ownership, validates every occurrence, and returns each occurrence's duration, segment breakdown, amount, conflicts, and the combined total. It writes nothing.
- `create_booking_series(class_id, room, student_details, occurrences[])` repeats all authorization, time, pricing, and conflict checks inside one transaction; generates one `series_id`; inserts the occurrences with sequential `series_index`; stores the server-generated snapshots; and succeeds completely or not at all.
- `edit_booking(id, expected_version, class_id, room, starts_at, ends_at, student_details)` changes one active occurrence only, preserves its teacher/series identity, rechecks overlaps, recalculates the snapshot, and rejects stale versions. Reassigning a booking to another teacher requires cancel/recreate.

Conflict details identify the affected date/room without exposing private fields or another teacher's price. Creation never trusts a quote token or amount supplied by the client; a changed rule between quote and confirmation simply produces the newly authoritative snapshot returned by creation.

## 6. Recurrence, editing, and cancellation

- Keep recurrence as concrete rows; do not store a recurrence rule or run a background generator.
- The form supports one-off reservations or a Monday-based start week, selected weekdays, and 1–52 weeks, capped at 104 occurrences.
- The browser materializes local start/end strings and previews every concrete date. The quote RPC returns each occurrence's price and the series total before confirmation.
- Every create action receives a new series ID, including a one-off reservation.
- Editing changes only the selected occurrence and recalculates its snapshot. Its immutable `series_index` keeps “future” cancellation stable even if the occurrence's date/time is edited.
- `cancel_booking(id, expected_version, scope)` accepts `one` or `future`. `future` cancels the selected active row and active rows in the same series with an equal or greater `series_index`.
- Owners can cancel their reservations; administrators can cancel any reservation. Cancellation is idempotent, records actor/time, frees room/teacher availability, retains the stored price snapshot, and makes that row's amount due zero.
- Corrections that change the teacher use cancel/recreate. Do not implement whole-series editing.

## 7. Authorization and privacy

Database policy, grants, and safe RPC projections—not frontend filtering—form the privacy boundary.

- Active profiles may read the safe day schedule containing booking ID, room, local start/end, teacher name, activity title, cancellation-free availability, and whether the actor may manage the booking.
- The shared schedule never returns `student_details`, `calculated_amount`, `price_breakdown`, or pricing-rule data.
- A teacher can read full details, snapshots, and reports only for their own bookings.
- An administrator can read/manage all booking details and all financial reports.
- Direct browser reads of the base bookings table and `private.pricing_rules` are revoked; use narrow RPCs/views so another teacher cannot request hidden columns manually.
- Inactive profiles and sessions not bound to an active profile cannot read or mutate app data.
- Schedule cells show other teachers' names and activity titles, as required, but never their student details or prices.

Use a safe `get_day(local_date)` RPC for the shared schedule, an owner/admin booking-details RPC, and the quote/mutation/report RPCs described in this plan. Keep `private.actor_id()`, `private.is_admin()`, and ownership helpers, simplified around active `auth_user_id` bindings.

## 8. Reports

Do not create a wallet, transaction table, payment status, or ledger. Reports derive the amount due from booking snapshots.

### Teacher monthly report

`get_my_month_report(month)` returns only the caller's bookings whose local `starts_at` date is in the selected calendar month:

- Reservation count and cancelled count.
- Date, start/end time, duration, room, activity title, snapshot price/breakdown, cancellation status, and effective amount due for each row.
- `effective amount due = calculated_amount` for active rows and `0` for cancelled rows.
- Monthly total due as the sum of effective amounts.

### Administrator monthly report

`get_admin_month_report(month, teacher_id nullable)` requires the admin role and returns:

- The same detail for all teachers or one selected teacher.
- Reservation/cancellation counts and total due per teacher.
- The combined cashbox total for all active reservation amounts in the month.

The React report screen provides a month selector. Teachers see only their personal report; administrators can switch between summary/all-teacher detail and one teacher. Both screens provide print CSS/browser printing and client-side CSV export of exactly the authorized rows already returned by the RPC. Do not add server-generated PDF/CSV files.

## 9. React user experience

### Schedule

- Label the two room columns `Зала` and `Стая`.
- Render a 30-minute grid covering the configured operating range and capable of showing every entry in the saved large-room programme, including 08:30 starts and multi-hour blocks.
- Render a booking across all intervals it occupies and show teacher name plus activity title.
- Distinguish load failure from an empty/free schedule; never present unknown availability as free.
- Refresh after mutation. Do not add realtime, polling, or an offline schedule cache.

### Booking form

- Clicking an empty interval preselects its room/date/start; the teacher chooses an end on a later 30-minute boundary.
- Select an existing active class/activity title and enter optional private student details.
- Support one-off and concrete recurrence generation.
- After room/date/start/end or recurrence changes, request a debounced server quote and show duration, applied segments/rates, each occurrence amount, and total before enabling confirmation.
- Treat quote failure, missing pricing, and conflicts as blocking. Creation still revalidates everything and displays the final returned total.
- Administrators may select a teacher/class when creating on behalf of someone; teachers are fixed to themselves.

### Details and cancellation

- Everyone may open the public slot summary; only owner/admin receives private details, price, edit, and cancellation controls.
- Owner/admin may edit the selected occurrence, cancel it, or cancel it and later occurrences when later active series rows exist.
- Cancelled history appears in authorized reports, not as an occupied schedule block.

### Reports and navigation

- Add a personal `Monthly report` destination for teachers.
- Add an administrator reporting destination with per-teacher and combined totals.
- Keep navigation within the SPA; no full-page POST/redirect workflow is introduced.

## 10. PWA and deployment

- Add a public static `manifest.webmanifest`, existing 192/512 icons, theme metadata, `start_url: "/"`, `scope: "/"`, and `display: "standalone"`.
- Reference the manifest statically from `index.html`; it contains no profile or token data.
- Do not register a service worker or add offline caching, background sync, install prompts, or cached availability.
- Keep Netlify SPA routing and security headers. Retain only the access function route among application functions after confirming no external health consumer.
- Update deployment checks/tests to expect the static manifest and absence of credential-bearing public artifacts.

## 11. Implementation sequence

1. **Schema baseline:** replace the experimental migration with the revised profiles/classes/bookings/pricing model, local-time validation, overlap exclusions, access resolution, quote/create/edit/cancel/day/detail/report RPCs, grants, RLS, deterministic pricing seeds, and regenerated database types/fixtures.
2. **Persistent access:** simplify the access function and session bootstrap; remove consume/cookie/version behavior and the profile, dynamic-manifest, and unused health paths plus their obsolete tests/configuration.
3. **Schedule and booking UI:** adapt current calendar/API/types/components to local 30-minute start/end values, variable-height bookings, room names, recurrence series, private details, quoting, editing, and both cancellation scopes.
4. **Reports:** add teacher/admin monthly screens, secure report calls, totals, print styles, and CSV generation.
5. **Static PWA and cleanup:** install the public manifest/icons, remove DST/UTC and obsolete function code/dependencies, update operations/release documentation, and verify built assets contain no secrets.
6. **Independent review:** implement each task from committed state in its own worktree and route completed work to an independent reviewer before acceptance, following `AGENTS.md`.

## 12. Acceptance tests

### Access and authorization

- The same personal link establishes native sessions in two clean browsers and still works after a messaging-app preview/open; it is never marked used.
- Link rotation rejects the old link and accepts the new one without ending existing sessions.
- Deactivation blocks an existing session on its next database call, invalidates the link, and reactivation requires a new link.
- A fragment exchanges even when a different profile session is present; a fragment-free reload restores the persisted session.
- Guest teachers behave exactly like other teacher profiles.
- Teachers cannot read another teacher's student details, price snapshots, or reports through UI, RPC manipulation, or direct REST table requests. Admins can access the authorized all-teacher views.

### Time, conflicts, and recurrence

- 08:30 and every other 30-minute boundary work; non-boundary, zero/negative, cross-date, duplicate, and over-104 occurrence requests fail.
- Multi-hour entries from the saved large-room schedule render correctly without committing or parsing `docs/schedule.jpg` at runtime.
- Adjacent bookings succeed; any room overlap or same-teacher overlap fails atomically, including simultaneous requests. Different teachers can book different rooms concurrently.
- Local dates/times remain unchanged across Sofia DST transition dates; no UTC offset/fold/gap logic remains in the booking path.
- Recurrence preview and creation contain identical concrete occurrences and one series ID. A conflict makes the entire series insert fail.
- Editing affects one occurrence and recalculates it. Cancel-one affects one row; cancel-future follows immutable series order; cancelled ranges become available immediately.

### Pricing

- Standard weekday, evening, and all three weekend bands calculate each 30-minute segment correctly.
- A standard 16:30–18:30 booking totals €42.50 (€5 + €25 + €12.50).
- Елеонора, Силвия, and Мария Бакалова price at €10/hour outside higher-precedence exceptions, regardless of room.
- Елеонора prices at €0 Monday–Thursday for 13:30–16:00 and 17:30–19:30; Friday falls back to €10/hour.
- Standard teachers, including Галя and guests, use standard rules.
- Missing and ambiguous rule configurations block quote/create; the browser cannot submit a forged amount.
- Rule edits affect new quotes and new/edited reservations but do not change existing untouched snapshots.
- Recurring quotes show per-occurrence amounts and the correct combined total across weekday/weekend/rate-boundary differences.

### Reports and UI

- A teacher's selected-month report includes only their rows, correct durations/snapshots/statuses, and an active-only total due.
- Cancelled rows retain original price information but contribute €0; no payment/settlement state exists.
- Admin per-teacher totals sum to the combined cashbox total for the month.
- Printed and CSV reports match the currently authorized filtered data and do not expose hidden fields.
- Schedule, booking, details, and reports are usable on phone and desktop with keyboard navigation, labels, focus handling, and accessible error/status messages.
- Static manifest/icons validate in standalone mode; no service worker or offline cache is registered.

### Quality gates

- Typecheck, unit/component tests, database integration/concurrency tests, Playwright permission/flow tests, production build, PWA verification, public-build secret scan, and a manual two-teacher/admin smoke test pass.
- Removed functions/routes and one-time/DST code have no remaining callers.
- `git status` contains only intentional files, no credentials, and no committed copy of `docs/schedule.jpg`.

## 13. Fixed assumptions and non-goals

- One Sofia facility uses local wall-clock schedule timestamps and EUR pricing.
- Rooms are fixed to `Зала` and `Стая`; both use the same rates and may host group or individual activities.
- Profiles and pricing rules are maintained through Supabase, not through app administration screens.
- The initial schedule UI supports at least 08:30–20:00 and may derive its displayed bounds from active pricing/configuration without changing the 30-minute model.
- There is no production data migration, legacy API compatibility, or framework migration.
- Out of scope: parent profiles/enrollment/notifications, teacher availability and booking requests/approval, attendance, payment collection/status, invoices, accounting ledger, external identity providers, email login, password login, offline behavior, and pricing/profile management UI.
