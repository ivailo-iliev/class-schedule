#!/usr/bin/env python3
"""Emit a change-only digest for the active Hermes Kanban board."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from importlib.machinery import SourceFileLoader

_board = SourceFileLoader(
    "kanban_board", str(Path(__file__).with_name("kanban-board.py"))
).load_module()

REPO = Path("/home/ivailo/class-scheduler")
BOARD = _board.active_board()
DB = _board.db_path(BOARD)
LAST = REPO / ".worktrees" / ".board-digest-last.json"


def rows():
    if not DB.exists():
        raise RuntimeError(f"Kanban database does not exist: {DB}")
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(
            "SELECT id,title,status,assignee,consecutive_failures,completed_at "
            "FROM tasks WHERE status NOT IN ('archived')"
        )]


def main() -> None:
    all_rows = rows()
    counts = {}
    for row in all_rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    done = sorted((row for row in all_rows if row["status"] == "done"),
                  key=lambda row: row["completed_at"] or 0)
    previous = {}
    try:
        previous = json.loads(LAST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    new_done = [row for row in done if row["id"] not in set(previous.get("done", []))]
    previous_counts = previous.get("counts", {})
    LAST.parent.mkdir(parents=True, exist_ok=True)
    LAST.write_text(json.dumps({"board": BOARD, "done": [row["id"] for row in done],
                                "counts": counts}), encoding="utf-8")
    if not new_done and counts == previous_counts and previous.get("board") == BOARD:
        print("NO CHANGE: board idle. " + " ".join(
            f"{key}={value}" for key, value in sorted(counts.items())
        ))
        return
    active = [row for row in all_rows if row["status"] in
              ("running", "ready", "blocked", "triage")]
    lines = ["Board " + BOARD + ": " + " ".join(
        f"{key}={value}" for key, value in sorted(counts.items())
    ), ""]
    if new_done:
        lines += ["COMPLETED SINCE LAST REPORT:"]
        lines += [f"- {row['title']} ({row['assignee']})" for row in new_done] + [""]
    if active:
        lines += ["ACTIVE:"]
        lines += [f"- {row['status']}: {row['title']} ({row['assignee']})" for row in active] + [""]
    remaining = sum(counts.get(key, 0) for key in
                    ("todo", "ready", "blocked", "running", "triage"))
    lines.append(f"Remaining: {remaining} of {len(all_rows)}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
