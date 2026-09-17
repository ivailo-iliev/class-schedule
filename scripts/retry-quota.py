#!/usr/bin/env python3
"""Requeue only active-board tasks whose latest failure was a quota wall."""

from __future__ import annotations

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
LOG = REPO / ".worktrees" / "retry.log"
QUOTA_MARKERS = (
    "rate limit", "rate-limited", "rate_limit", "quota", "429",
    "resource_exhausted", "usage limit", "capacity",
)


def log(message: str) -> None:
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")


def kanban(*args: str):
    return subprocess.run(
        ["hermes", "kanban", *_board.cli_board_args(BOARD), *args],
        cwd=REPO, text=True, capture_output=True, check=False,
    )


def codex_clear() -> bool:
    result = subprocess.run(["hermes", "auth", "list"], text=True,
                            capture_output=True, timeout=30, check=False)
    if result.returncode != 0:
        log(f"auth probe failed; refusing to requeue: {result.stderr.strip()[:240]}")
        return False
    return not ("rate-limited" in result.stdout and "openai-codex" in result.stdout)


def stalled_on_quota():
    if not DB.exists():
        return []
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT id,title,status,last_failure_error FROM tasks "
            "WHERE status IN ('blocked','todo','triage')"
        ).fetchall()
    return [(row["id"], row["title"]) for row in rows
            if any(marker in (row["last_failure_error"] or "").lower()
                   for marker in QUOTA_MARKERS)]


def main() -> None:
    log(f"retry tick board={BOARD}")
    if not codex_clear():
        log("codex unavailable or rate-limited — nothing requeued")
        return
    for task_id, title in stalled_on_quota():
        result = kanban("unblock", task_id)
        if result.returncode == 0:
            log(f"REQUEUED {task_id} :: {title}")
        else:
            log(f"UNBLOCK-FAILED {task_id} :: {title} :: "
                f"{(result.stderr or result.stdout).strip()[:240]}")


if __name__ == "__main__":
    main()
