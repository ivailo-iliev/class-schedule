# Class Scheduler orchestration helpers

This document covers local workflow helpers. They do not implement application
features and do not deploy the application.

## Quick commands

Run from `/home/ivailo/class-scheduler`:

```text
scripts/kanban-cron list
scripts/kanban-cron status
scripts/kanban-cron gaps
scripts/kanban-cron retry-quota
scripts/kanban-cron tick
scripts/kanban-cron pause status
scripts/kanban-cron resume status
python3 scripts/github-delivery-bridge.py
```

`kanban-cron` resolves cron job IDs by name from the planner profile. Do not
copy job IDs into scripts, documentation, or shell aliases.

The jobs belong to the `planner` profile. The default profile has no project
cron jobs and is not used for this workflow.

## Active cron jobs

The active board is resolved from `HERMES_KANBAN_BOARD`, then the Hermes
`kanban/current` pointer, and finally `default`. The current project tasks live
on the default board; do not hardcode a SQLite path in a helper.

### `gaps` — every 10 minutes

Script: `~/.hermes/profiles/planner/scripts/kanban-gaps.py`

This is the small gap-filler for behavior the Hermes Kanban dispatcher does
not provide:

- detects consecutive task-level budget exhaustion while a task is currently
  blocked, then flags the task for planner review instead of retrying forever;
- writes `.worktrees/status.md` as a compact local status file.

It does not decompose triage, retry ordinary tasks, or requeue quota failures.
The Hermes dispatcher owns triage decomposition and ordinary dispatch; this
helper only escalates a blocked coder-budget task to coder-strong after two
consecutive explicit budget failures; the quota job owns quota requeue.

The script deliberately ignores historical budget failures when a task is
running or healthy. This prevents a repaired task from being blocked because
of an old failed attempt.

### `status` — every 10 minutes

Script: `~/.hermes/profiles/planner/scripts/board-digest.py`

This script compares the board with its previous digest and emits a report
when tasks complete or statuses change. The cron job runs the planner agent
with that output. The planner may report status and act on genuine judgment
calls, such as a feasibility decision or routing a reviewer finding.

When the `status` job uses `local` delivery, its report is saved in the
planner cron output directory and is not pushed into this CLI conversation.
`origin` is not suitable here: in this environment it resolves to a Telegram
chat and fails if that gateway has no bot token. The wrapper command still
works without IDs; inspect the saved report with `hermes -p planner cron
history` or run `scripts/kanban-cron status` and read the latest cron output.

### `retry-quota` — every 60 minutes

Script: `~/.hermes/profiles/planner/scripts/retry-quota.py`

This script checks the openai-codex credential state. If Codex is still
rate-limited, it does nothing. If the limit cleared, it requeues only tasks
whose latest failure is identified as a quota/rate-limit failure.

It does not requeue tasks blocked by budget exhaustion, contradictions,
missing credentials, or owner decisions. It runs without an LLM.

## Acceptance and sizing guardrails

Keep implementation goals small enough for one worker run. Split work that is
likely to exceed 60 turns; use the strong lane only after repeated substantive
budget failure, not as a first resort. The default implementation lane is
coder-budget (30–60 turns), with coder-strong reserved for the deterministic
escalation above.

An implementation is not accepted merely because its worker run completed:
the reviewer must inspect the committed branch and record an outcome on the
task. A blocking finding requires a fix and a fresh review. The gateway's
native review dispatch is the preferred path; final acceptance is the durable
task status plus the review comment or event.

## Manual cron control

The wrapper uses the planner profile:

```text
scripts/kanban-cron pause status
scripts/kanban-cron resume status
scripts/kanban-cron pause gaps
scripts/kanban-cron resume gaps
scripts/kanban-cron pause retry-quota
scripts/kanban-cron resume retry-quota
```

Run due planner jobs immediately:

```text
scripts/kanban-cron tick
```

Run one named job immediately, regardless of its next scheduled time:

```text
scripts/kanban-cron status
scripts/kanban-cron gaps
scripts/kanban-cron retry-quota
```

Inspect durable job history when a job reports failure:

```text
hermes -p planner cron history
hermes -p planner cron incidents
```

## Durable state

Hermes Kanban remains the source of truth for:

- task status;
- task assignee;
- task claims and runs;
- consecutive failure count;
- dependency links;
- comments and event history.

Cron state remains in the planner profile and survives process restarts. Cron's
built-in occurrence ledger and tick lock prevent duplicate scheduled runs.
The helper scripts add no second task-state database; their small JSON files
only remember the last digest and which local gap actions were already applied.

## Inactive scripts

`/home/ivailo/class-scheduler/.worktrees/supervise.py` and `monitor.py` are not
active. They are earlier broad-supervisor experiments and must not be started
alongside the gateway dispatcher or the cron helpers.

## Troubleshooting

Check the current jobs without remembering IDs:

```text
scripts/kanban-cron list
```

Check the local digest:

```text
cat .worktrees/status.md
```

If a script job fails, inspect its durable history:

```text
hermes -p planner cron history
hermes -p planner cron incidents
```

The live dispatcher is `hermes-gateway.service`. Verify it with
`systemctl --user status hermes-gateway.service`; do not use the retired
`hermes-gateway-hy3-preview.service` name. The checked-in
`hermes-resume.service` definition points at the live unit, but is intentionally
disabled on hosts whose user manager does not provide `sleep.target`.

Planner cron validates and executes profile-local script copies from
`~/.hermes/profiles/planner/scripts/`. The versioned sources are under
`scripts/`; after changing one, install that exact copy there and keep the
shared `~/.hermes/scripts/` copy synchronized for compatibility.

Never put passwords, API tokens, private keys, or raw teacher access links in
this document or in task comments.

For the GitHub PR, CI, and merge lifecycle, see
[`autonomous-delivery.md`](autonomous-delivery.md).
