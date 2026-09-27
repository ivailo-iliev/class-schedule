# Class Scheduler agent rules

Approved scope: `plans/class-scheduler-refactor/implementation-plan.md` (not the superseded v2 rewrite). Work on the `class-scheduler` Kanban board/project. Code cards use committed base + isolated `worktree`, `goal_mode=true`, ~20 goal turns, focused acceptance criteria, and PR completion contract `ivailo-iliev/class-schedule`. Planner/reviewer cards are one-shot. Do not touch unrelated user changes or commit secrets/`.env`.

## Autonomous flow
- Owner pre-authorized product decisions, publication and merges. Resolve routine blockers from the plan, code and tests; ask only for indispensable external access. No OS uninstall, force-push, protection bypass or fabricated checks.
- Create roots from persistent planner gateway chat and verify `notify+wake` subscription BEFORE dispatch. CLI-created cards need explicit subscription. If a goal card exhausts its turn budget, leave original blocked; planner makes one idempotent reviewer decomposition card keyed by original/run. Reviewer gates smaller goal/worktree coding cards on its own completion, plus planner fan-in on their completion; never parent replacements on blocked original or create cycles. Fan-in verifies original criteria at integrated SHA, re-gates downstream links, then retires original with audit evidence. Diagnose stale `ready`/`todo` rather than duplicating cards. No idle cron scans.
- Coder commits/pushes PR, waits for exact-head required `quality`, and requests same-card independent reviewer. Red checks/rework stay on that card. Reviewer rechecks PR/base/diff/head/checks, directly squash-merges with `--match-head-commit`, and reads back MERGED + merge SHA before completion. Never use queued `--auto` or `--admin`. Preserve open stacked PR bases; verify repo `allow_auto_merge=false` and `delete_branch_on_merge=false` before stacked merges. Every branch chain reaches `main`.

## Kanban completion contracts
- The canonical completion contract for repository PR tasks is `ivailo-iliev/class-schedule`. Never create a task with the placeholder `OWNER/REPO` or any unresolved placeholder.
- If the exact PR is already known, use the exact PR URL instead. Use `local-only` only for tasks that must not publish a PR, such as integrated verification.
- The planner must read back every child card before completing planning and verify that each PR-producing card has a valid contract: `ivailo-iliev/class-schedule` or an exact PR URL. Repair invalid contracts before dispatching children.
- A PR worker must include `metadata.published_pr` with the real PR URL, exact head SHA, required-check evidence, review verdict, and merge/readback result. The URL repository must match the persisted completion contract.
- If completion is rejected because of a contract mismatch, do not rerun implementation or create a replacement PR. Correct the persisted contract, comment the blockage and resolution on the card, retry completion, and verify dependent cards are released.

## CI and test cadence
- Keep `.github/workflows/ci.yml` tracked; required job name is `quality`. Always run typecheck, unit and build. Skip Playwright install + PWA only if EVERY changed path is `AGENTS.md`, `README.md`, `plans/*` or `docs/*`; manual runs always include PWA. Code/CI changes and unavailable diff ranges run PWA.
- Run focused checks per coding card, not full DB/browser E2E. ONE final reviewer verification card per cohesive code batch, gated on all reviewed/merged implementation, runs manual `gh workflow run ci.yml --ref <integrated-ref> -f run_full_e2e=true` on the integrated SHA and records result. No recurring E2E; policy/docs-only changes do not need full E2E.
- DB/E2E uses isolated local Supabase per `supabase/config.toml`, never the linked production project or production credentials.
