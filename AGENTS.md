# Class Scheduler — agent instructions

## Kanban workflow and blocked tasks

- Use Hermes Kanban for durable project work. Create tasks from the persistent planner gateway session so native `notify+wake` subscriptions route task events back to the planner. Do not create a parallel polling/retry pipeline or reimplement Kanban state in scripts.
- When a blocked, gave-up, crashed, timed-out, or review-requested event wakes the planner, inspect the task, recent run, and complete comment thread before deciding. If the blocker is resolvable within the planner's authority, fix the underlying cause, unblock the task, and add a concise audit comment. If it needs human input, credentials, or external access, leave it blocked and state the exact next action; never blindly unblock it.
- Provider rate-limit/quota outcomes are handled by the native Kanban dispatcher: it requeues without counting a task failure and retries after its cooldown (currently five minutes by default). Do not add quota cron jobs or manually unblock these tasks. Distinguish provider quota cooldown from a worker's per-run turn/iteration budget; budget exhaustion needs task-level diagnosis, not quota retry logic.
- Keep recurring cron jobs out of the coding pipeline unless the requested work genuinely depends on elapsed time. Do not run idle board scans, scheduled digests, or scheduled E2E cycles.

## CI and test cadence

- `.github/workflows/ci.yml` is the canonical, tracked GitHub Actions workflow. Keep it in the repository; do not hide it in `.git/info/exclude` or mix Kanban orchestration scripts into it.
- The required `quality` check runs on pull requests and pushes to `main`: `npm run typecheck`, `npm run test:unit`, `npm run build`, and `npm run test:pwa`. Preserve its stable job name because branch protection requires that check.
- Keep per-task tests focused on the changed code. Do not run the full database/browser E2E suite after every Kanban card.
- At the end of a cohesive coding batch, create one final verification card with dependency links to all implementation and integration/merge cards. It must run only after the batch is integrated on a single ref. That verifier triggers `gh workflow run ci.yml --ref <integrated-ref> -f run_full_e2e=true` and waits for the result; if dispatch is unavailable, run `npm run test:db` and `npm run test:e2e` against an isolated local Supabase environment. Report the tested ref/SHA and exact outcomes. Never trigger full E2E on a recurring schedule.
- Supabase tests must use the local project from `supabase/config.toml`; do not point test commands at the linked production project or production credentials.

## General project safeguards

- Preserve uncommitted user changes. Do not stage or commit unrelated files.
- Keep browser E2E, DB integration tests, and fast unit/type/build checks clearly separated so routine task feedback stays quick.
- Never use force-push or bypass commands to work around branch protection. The `main` branch requires linear history, so merge pull requests with squash or rebase and confirm required checks first.
