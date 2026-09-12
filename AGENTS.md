# Hermes Autonomous Software Development — Project Policy (canonical template)

> Copy this file to the ROOT of every project git repo as `AGENTS.md`.
> Hermes loads it (git-root → cwd chain) into the system prompt of the
> planner/orchestrator AND every worker operating in that repo's worktree.
> This is the durable, strictly-followed orchestration contract.

## Profiles & routing (managed in ~/.hermes/config.yaml + kanban dispatcher)
- planner        → GPT-6 Astra (Codex). Orchestration only: plan, decompose,
                   architect, escalate, final review. NEVER implements.
- coder-budget   → openrouter/pareto-code, min_coding_score 0.25. Default
                   implementation worker. Small tasks, ~30 turns.
- coder-strong   → openrouter/pareto-code, min_coding_score 0.65. Hard tasks.
- reviewer       → GPT-6 Astra (Codex). Independent review/verification.

## Kanban = durable source of truth (not conversation memory)
- Tasks, claims, runs, comments, events persist on the board across restarts.
- Dispatcher runs inside the gateway (hermes-gateway-hy3-preview.service,
  user systemd, linger=yes, Restart=always) and auto-recovers.
- orchestrator_profile = planner; default_assignee = coder-budget.

## Decomposition rules
- Small, self-contained tasks a fresh worker finishes in one run.
- Set goal_max_turns conservatively so cheap sessions are replaced, not bloated.
- Use board auto-decompose for triage/parent tasks.

## Escalation
- Default impl = coder-budget. After REPEATED SUBSTANTIVE failure, escalate to
  coder-strong. Reserve frontier (GPT-6 Astra) for planning/escalation/review.
- After implementation, route to reviewer before acceptance.

## Git safety (mandatory)
- git init BEFORE implementation if not already version-controlled.
- Create a BASELINE COMMIT before autonomous development starts.
- Every task starts from committed state.
- Workers commit coherent completed work to their OWN worktree branch before
  handoff/review.
- Preserve recoverable history BEFORE destructive/risky changes.
- NEVER commit credentials, tokens, .env, or secrets.

## Worktrees
- Parallel workers MUST use git worktrees (dispatcher assigns worktree+branch
  per task inside a git repo). Never share a working tree between workers.

## Secrets & hygiene
- Secrets only via Hermes secret/env config (profile .env / auth.json).
- Never put credentials in task descriptions, kanban comments, git history,
  or logs when avoidable.
- Dashboard stays local-only.

## Final acceptance
- Task accepted only after reviewer independently reviews with no blocking
  findings (or the finding is fixed + re-reviewed).
- Record review outcomes as task comments for auditability.
