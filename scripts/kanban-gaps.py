#!/usr/bin/env python3
"""Deterministic gap-filler for the active Hermes Kanban board.

Hermes owns triage decomposition, ordinary retries, and dependency promotion.
This helper handles the one policy exception that the native dispatcher does
not implement: after repeated substantive budget exhaustion it escalates a
blocked coder-budget task to coder-strong, then flags an infeasible task for
planner judgment. It never mutates healthy tasks.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

from importlib.machinery import SourceFileLoader

_board = SourceFileLoader(
    "kanban_board", str(Path(__file__).with_name("kanban-board.py"))
).load_module()

REPO = Path("/home/ivailo/class-scheduler")
BOARD = _board.active_board()
DB = _board.db_path(BOARD)
LOG = REPO / ".worktrees" / "monitor.log"
STATUS = REPO / ".worktrees" / "status.md"
STATE = REPO / ".worktrees" / "gap-state.json"

ESCALATE_AFTER = 2
INFEASIBLE_AFTER = 3
# A timeout can be infrastructure or quota related; only explicit exhaustion
# is substantive enough to justify moving a task to the strong lane.
BUDGET_MARKERS = ("iteration budget", "budget exhausted", "gave_up")


def log(message: str) -> None:
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")


def load(path: Path, default):
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=1)
    os.replace(temporary, path)


def rows():
    if not DB.exists():
        return []
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(
            "SELECT id,title,status,assignee,consecutive_failures,last_failure_error "
            "FROM tasks WHERE status NOT IN ('done','archived')"
        )]


def budget_runs(task_id: str):
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(
            "SELECT outcome,error FROM task_runs WHERE task_id=? "
            "ORDER BY id DESC LIMIT 20", (task_id,)
        )]


def kanban(*args: str):
    return subprocess.run(
        ["hermes", "kanban", *_board.cli_board_args(BOARD), *args],
        cwd=REPO, text=True, capture_output=True, check=False,
    )


def tick() -> None:
    state = load(STATE, {})
    for task in rows():
        task_id = task["id"]
        record = state.setdefault(task_id, {"title": task["title"]})
        if task["status"] != "blocked":
            continue
        runs = budget_runs(task_id)
        count = 0
        for run in runs:
            text = ((run.get("error") or "") + (run.get("outcome") or "")).lower()
            if any(marker in text for marker in BUDGET_MARKERS):
                count += 1
            else:
                break
        if count >= ESCALATE_AFTER and task.get("assignee") == "coder-budget" \
                and not record.get("escalated"):
            result = kanban("reassign", task_id, "coder-strong", "--reclaim")
            if result.returncode == 0:
                record["escalated"] = True
                log(f"ESCALATE {task_id} -> coder-strong ({count}) :: {task['title']}")
                continue
            else:
                record["escalate_failed"] = True
                log(f"ESCALATE-FAILED {task_id}: {result.stderr.strip()[:240]}")
        if count >= INFEASIBLE_AFTER and not record.get("flagged"):
            record.update(flagged=True, budget_attempts=count)
            result = kanban(
                "comment", task_id,
                f"Planner: exhausted the turn budget {count} times. "
                "Decide whether to split, narrow, or reject this task; do not retry unchanged.",
            )
            if result.returncode != 0:
                record["comment_failed"] = True
                log(f"COMMENT-FAILED {task_id}: {result.stderr.strip()[:240]}")
            log(f"INFEASIBLE {task_id} {count} budget attempts :: {task['title']}")

    save(STATE, state)
    current = rows()
    counts = {}
    for task in current:
        counts[task["status"]] = counts.get(task["status"], 0) + 1
    lines = [f"# status {time.strftime('%Y-%m-%d %H:%M:%S')}", "", " ".join(
        f"{key}={value}" for key, value in sorted(counts.items())
    ), ""]
    for task in current:
        if task["status"] in ("running", "ready", "blocked", "triage"):
            lines.append(f"- `{task['id']}` **{task['status']}** "
                         f"{task['assignee']} — {task['title']}")
    flagged = [key for key, value in state.items() if value.get("flagged")]
    if flagged:
        lines += ["", "## needs planner decision"]
        lines += [f"- `{key}` {state[key].get('title', '')} "
                  f"({state[key].get('budget_attempts')} budget failures)" for key in flagged]
    temporary = STATUS.with_name(STATUS.name + ".tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temporary, STATUS)


if __name__ == "__main__":
    try:
        tick()
    except Exception as exc:  # keep cron failures visible, never silently swallow them
        log(f"ERROR {exc}")
        raise
