# Autonomous GitHub delivery

Hermes remains the system of record for planning, task routing, worktrees,
review, and escalation. GitHub is the deterministic delivery layer: a PR gets
CI checks, then the bridge requests an auto-merge only after Hermes has an
independent reviewer completion.

```text
Hermes task → committed worktree branch → PR → CI → Hermes reviewer
          → exact-head acceptance → auto-merge → CI on main
                                              ↘ failure issue → Hermes repair task
```

## One-time GitHub setup

Authenticate the account that runs Hermes with repository write access:

```text
gh auth login -h github.com
```

On the repository's `main` branch, require the two checks supplied by
`.github/workflows/ci.yml`:

- `quality`
- `integration`

Enable GitHub auto-merge and retain normal branch-protection restrictions
(force pushes and direct unreviewed pushes should remain disabled). Hermes's
native PR completion contract refuses to mark a task complete if required
checks are missing, pending, failing, stale, or inaccessible.

## Task contract

The planner creates every publishable implementation task with:

```text
--workspace worktree
--completion-contract ivailo-iliev/class-schedule
--skill github-pr-workflow
```

The worker commits its changes and requests Hermes review. The bridge only
publishes a committed branch while the task is in `review`. It comments the PR
URL on the card. The reviewer then completes the task with that exact URL in
`metadata.published_pr`; this binds the card to the PR head and verifies its
required checks. Only then can the bridge request squash auto-merge.

## Running the bridge

The default is read-only and safe for diagnosis:

```text
python3 scripts/github-delivery-bridge.py
```

Use `--apply` from the planner host to publish review-ready branches, record
PR evidence, and request auto-merge for accepted cards:

```text
python3 scripts/github-delivery-bridge.py --apply
```

The bridge is installed as a no-agent planner cron job every 10 minutes. It
remains inert (with a clear local `BLOCKED` result) until GitHub authentication
and branch protection are configured. To reinstall it after source changes,
copy the two versioned Python files to both the planner profile and shared
script directories:

```text
cp scripts/kanban-board.py scripts/github-delivery-bridge.py ~/.hermes/scripts/
cp scripts/kanban-board.py scripts/github-delivery-bridge.py ~/.hermes/profiles/planner/scripts/
```

```text
hermes -p planner cron create 'every 10m' \
  --name github-delivery \
  --script github-delivery-bridge.py \
  --no-agent \
  --deliver local \
  --workdir /home/ivailo/class-scheduler
```

An unavailable or expired GitHub credential is a real delivery blocker, not a
retry loop: no branch is pushed, no PR is created, and no card is changed.

## CI scope

`quality` runs typechecking, unit/UI tests, orchestration tests, a production
build, and the PWA check. `integration` starts an ephemeral local Supabase
stack, runs database tests, and exercises Playwright on Chromium and WebKit.
Both run on pull requests and again after merge to `main`.

When either post-merge job fails, GitHub creates one labeled `hermes-repair`
issue per failing commit. The bridge converts that issue into an idempotent
`coder-budget` worktree task with the same PR contract, so the repair follows
the full implement → review → merge path instead of silently leaving `main`
red.
