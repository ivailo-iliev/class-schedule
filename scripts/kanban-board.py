#!/usr/bin/env python3
"""Small shared board-path helpers for the class-scheduler cron scripts."""

from __future__ import annotations

import os
import re
from pathlib import Path


_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def hermes_home() -> Path:
    return Path(os.environ.get("HERMES_KANBAN_HOME", "/home/ivailo/.hermes"))


def active_board() -> str:
    explicit = os.environ.get("HERMES_KANBAN_BOARD", "").strip().lower()
    if explicit:
        board = explicit
    else:
        pointer = hermes_home() / "kanban" / "current"
        try:
            board = pointer.read_text(encoding="utf-8").strip().lower()
        except OSError:
            board = "default"
    if not board:
        board = "default"
    if not _SLUG.fullmatch(board):
        raise SystemExit(f"invalid HERMES_KANBAN_BOARD: {board!r}")
    return board


def db_path(board: str | None = None) -> Path:
    slug = board or active_board()
    if slug == "default":
        return hermes_home() / "kanban.db"
    return hermes_home() / "kanban" / "boards" / slug / "kanban.db"


def cli_board_args(board: str) -> list[str]:
    return ["--board", board]
