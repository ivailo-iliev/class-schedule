# Hermes Autonomous Software Development — Project Policy (canonical template)

> Copy this file to the ROOT of every project git repo as `AGENTS.md`.
> Hermes loads it (git-root → cwd chain) into the system prompt of the
> planner/orchestrator AND every worker operating in that repo's worktree.
> This is the durable, strictly-followed orchestration contract.

## Profiles & routing (managed in ~/.hermes/config.yaml + kanban dispatcher)
- planner        → gpt-5.6-terra via openai-codex. Orchestration only: plan, decompose,
                   architect, escalate, final review. NEVER implements.
- coder-budget   → gpt-5.6-luna via openai-codex. Default implementation
                   worker. Small tasks, normally 30–60 turns.
- coder-strong   → gpt-5.6-terra via openai-codex. Hard tasks.
- reviewer       → gpt-5.6-terra via openai-codex. Independent review/verification.

## Kanban = durable source of truth (not conversation memory)
- Tasks, claims, runs, comments, events persist on the board across restarts.
- Dispatcher runs inside the gateway (hermes-gateway.service, user systemd,
  linger=yes, Restart=always) and auto-recovers. A resume unit definition also
  targets this service; it remains disabled unless the host provides a valid
  sleep/resume target to the user manager.
- orchestrator_profile = planner; default_assignee = coder-budget.

## Decomposition rules
- Small, self-contained tasks a fresh worker finishes in one run.
- Split work likely to exceed 60 turns; set goal_max_turns conservatively so
  cheap sessions are replaced, not bloated.
- Use board auto-decompose for triage/parent tasks.

## Escalation
- Default impl = coder-budget. After REPEATED SUBSTANTIVE failure, escalate to
  coder-strong. Reserve the higher-capacity Terra lane for planning/escalation/review.
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
