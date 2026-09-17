#!/usr/bin/env python3
"""Publish reviewed Hermes worktree branches and merge accepted PRs.

The bridge is deliberately conservative.  A default run is read-only; --apply
is required for GitHub or Kanban writes.  It only publishes tasks in first-class
``review`` with a declared GitHub completion contract, and only enables
auto-merge after the independent Hermes reviewer has completed the task.  Hermes
itself verifies the exact PR head's required checks before that completion.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from importlib.machinery import SourceFileLoader
from pathlib import Path
from typing import Iterable


REPO = Path(os.environ.get("HERMES_PROJECT_ROOT", "/home/ivailo/class-scheduler"))
_board = SourceFileLoader(
    "kanban_board", str(Path(__file__).with_name("kanban-board.py"))
).load_module()
BOARD = _board.active_board()
DB = _board.db_path(BOARD)
_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_PR_URL = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/[1-9][0-9]*$")
_BRANCH = re.compile(r"^(?!.*(?:^|/)\.\.?/)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")


@dataclass(frozen=True)
class Task:
    id: str
    title: str
    status: str
    branch_name: str
    workspace_path: str | None
    completion_contract: str


@dataclass(frozen=True)
class RepairIssue:
    number: int
    title: str
    url: str


class BridgeError(RuntimeError):
    """A safe, actionable bridge failure; never include subprocess output."""


def command(args: list[str], *, cwd: Path = REPO) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=cwd, stdin=subprocess.DEVNULL, text=True,
                          capture_output=True, check=False)


def github_repository(remote: str) -> str | None:
    """Return owner/repo for a standard GitHub SSH or HTTPS remote."""
    value = remote.strip().removesuffix(".git")
    match = re.search(r"github\.com(?::|/)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$", value)
    return match.group(1) if match else None


def contract_repository(contract: str) -> str | None:
    if _REPOSITORY.fullmatch(contract):
        return contract
    match = _PR_URL.fullmatch(contract)
    return match.group(1) if match else None


def is_exact_pr(contract: str) -> bool:
    return _PR_URL.fullmatch(contract) is not None


def publishable(task: Task, repository: str) -> bool:
    return (
        task.status == "review"
        and _BRANCH.fullmatch(task.branch_name) is not None
        and contract_repository(task.completion_contract) == repository
    )


def intakeable(issue: RepairIssue) -> bool:
    return issue.number > 0 and issue.title.startswith("Hermes repair: CI failed for ") \
        and issue.url.startswith("https://github.com/")


def rows() -> list[Task]:
    if not DB.exists():
        raise BridgeError(f"Kanban database does not exist: {DB}")
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        result = connection.execute(
            "SELECT id,title,status,branch_name,workspace_path,completion_contract "
            "FROM tasks WHERE status IN ('review','done') "
            "AND completion_contract IS NOT NULL AND completion_contract != 'local-only' "
            "AND branch_name IS NOT NULL"
        ).fetchall()
    return [Task(**dict(row)) for row in result]


def git_repository() -> str:
    result = command(["git", "remote", "get-url", "origin"])
    repository = github_repository(result.stdout) if result.returncode == 0 else None
    if not repository:
        raise BridgeError("origin is not a standard GitHub owner/repository remote")
    return repository


def default_branch(repository: str) -> str:
    result = command(["gh", "repo", "view", repository, "--json", "defaultBranchRef"])
    if result.returncode != 0:
        raise BridgeError("cannot read the GitHub repository default branch")
    try:
        branch = json.loads(result.stdout)["defaultBranchRef"]["name"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise BridgeError("GitHub returned no default branch") from exc
    if not isinstance(branch, str) or not _BRANCH.fullmatch(branch):
        raise BridgeError("GitHub returned an invalid default branch")
    return branch


def github_available() -> bool:
    # ``gh auth status`` can return zero for a stored but expired token.  A
    # small authenticated API read proves the credential is usable without
    # exposing it or mutating remote state.
    return command(["gh", "api", "user", "--hostname", "github.com"]).returncode == 0


def branch_has_commit(task: Task, base: str) -> bool:
    if command(["git", "rev-parse", "--verify", "--quiet", f"refs/heads/{task.branch_name}"]).returncode != 0:
        return False
    result = command(["git", "rev-list", "--count", f"{base}..{task.branch_name}"])
    return result.returncode == 0 and result.stdout.strip().isdigit() and int(result.stdout) > 0


def worktree_clean(task: Task) -> bool:
    if not task.workspace_path:
        return True
    path = Path(task.workspace_path)
    if not path.is_dir():
        return True
    result = command(["git", "status", "--porcelain"], cwd=path)
    return result.returncode == 0 and not result.stdout.strip()


def gh_json(args: list[str]) -> dict | None:
    result = command(["gh", *args])
    if result.returncode != 0:
        return None
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def gh_list(args: list[str]) -> list[dict] | None:
    result = command(["gh", *args])
    if result.returncode != 0:
        return None
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, list) and all(isinstance(item, dict) for item in value) else None


def find_pr(repository: str, branch: str) -> dict | None:
    return gh_json([
        "pr", "view", branch, "--repo", repository,
        "--json", "url,state,isDraft,mergeStateStatus,headRefOid",
    ])


def comment_exists(task_id: str, needle: str) -> bool:
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as connection:
        row = connection.execute(
            "SELECT 1 FROM task_comments WHERE task_id=? AND body LIKE ? LIMIT 1",
            (task_id, f"%{needle}%"),
        ).fetchone()
    return row is not None


def add_comment(task: Task, text: str, *, apply: bool) -> str | None:
    if comment_exists(task.id, text):
        return None
    if not apply:
        return f"would comment on {task.id}: {text}"
    result = command([
        "hermes", "kanban", *_board.cli_board_args(BOARD), "comment", task.id, text,
        "--author", "github-delivery-bridge",
    ])
    if result.returncode != 0:
        raise BridgeError(f"could not record GitHub delivery evidence for {task.id}")
    return f"commented on {task.id}: {text}"


def create_pr(task: Task, repository: str, base: str, *, apply: bool) -> tuple[str | None, str | None]:
    existing = find_pr(repository, task.branch_name)
    if existing and isinstance(existing.get("url"), str):
        return existing["url"], None
    if not branch_has_commit(task, base):
        return None, f"{task.id}: branch {task.branch_name} has no commit ahead of {base}"
    if not worktree_clean(task):
        return None, f"{task.id}: worktree has uncommitted changes; worker must commit before publication"
    if not apply:
        return None, f"would publish {task.id} branch {task.branch_name} as a PR"
    push = command(["git", "push", "--set-upstream", "origin", task.branch_name])
    if push.returncode != 0:
        raise BridgeError(f"could not push task branch for {task.id}")
    body = f"Automated Hermes task: `{task.id}`.\n\nCI and independent Hermes review are required before merge."
    created = command([
        "gh", "pr", "create", "--repo", repository, "--base", base,
        "--head", task.branch_name, "--title", f"[{task.id}] {task.title}", "--body", body,
    ])
    if created.returncode != 0:
        raise BridgeError(f"could not create a PR for {task.id}")
    url = created.stdout.strip()
    if _PR_URL.fullmatch(url) is None:
        raise BridgeError(f"GitHub returned an invalid PR URL for {task.id}")
    return url, f"published {task.id}: {url}"


def enable_automerge(task: Task, repository: str, *, apply: bool) -> str | None:
    if task.status != "done" or not is_exact_pr(task.completion_contract):
        return None
    pr = gh_json([
        "pr", "view", task.completion_contract, "--repo", repository,
        "--json", "url,state,isDraft,mergeStateStatus",
    ])
    if pr is None:
        return f"{task.id}: cannot read its bound PR"
    url = str(pr.get("url") or task.completion_contract)
    state = pr.get("state")
    if state == "MERGED":
        return add_comment(task, f"GitHub delivery: merged {url}", apply=apply)
    if state != "OPEN" or pr.get("isDraft"):
        return f"{task.id}: bound PR is not an open mergeable PR"
    if not apply:
        return f"would enable squash auto-merge for {task.id}: {url}"
    result = command([
        "gh", "pr", "merge", url, "--repo", repository, "--auto", "--squash", "--delete-branch",
    ])
    if result.returncode != 0:
        return f"{task.id}: GitHub did not accept the auto-merge request"
    return add_comment(task, f"GitHub delivery: auto-merge requested for {url}", apply=True)


def repair_issues(repository: str) -> list[RepairIssue]:
    issues = gh_list([
        "issue", "list", "--repo", repository, "--label", "hermes-repair", "--state", "open",
        "--json", "number,title,url", "--limit", "100",
    ])
    if issues is None:
        raise BridgeError("cannot read GitHub repair issues")
    result: list[RepairIssue] = []
    for issue in issues:
        try:
            candidate = RepairIssue(number=int(issue["number"]), title=str(issue["title"]), url=str(issue["url"]))
        except (KeyError, TypeError, ValueError):
            continue
        if intakeable(candidate):
            result.append(candidate)
    return result


def intake_repair(issue: RepairIssue, repository: str, *, apply: bool) -> str:
    key = f"github-repair:{repository}:{issue.number}"
    if not apply:
        return f"would create a Hermes repair task for GitHub issue #{issue.number}"
    body = (
        f"Automated post-merge CI repair from {issue.url}.\n\n"
        "Inspect the linked GitHub Actions run, reproduce the failure, add a regression test, "
        "and deliver the fix through the normal PR completion contract."
    )
    result = command([
        "hermes", "kanban", *_board.cli_board_args(BOARD), "create", issue.title,
        "--body", body,
        "--assignee", "coder-budget",
        "--workspace", "worktree",
        "--completion-contract", repository,
        "--skill", "github-pr-workflow",
        "--idempotency-key", key,
    ])
    if result.returncode != 0:
        raise BridgeError(f"could not create Hermes repair task for GitHub issue #{issue.number}")
    return f"intaked GitHub repair issue #{issue.number}: {result.stdout.strip()}"


def synchronize(*, apply: bool) -> Iterable[str]:
    if not github_available():
        yield "BLOCKED: GitHub authentication is unavailable; no delivery action was attempted."
        return
    repository = git_repository()
    base = default_branch(repository)
    for task in rows():
        if contract_repository(task.completion_contract) != repository:
            continue
        if publishable(task, repository):
            url, detail = create_pr(task, repository, base, apply=apply)
            if detail:
                yield detail
            if url:
                note = add_comment(task, f"GitHub PR: {url}", apply=apply)
                if note:
                    yield note
        merge_note = enable_automerge(task, repository, apply=apply)
        if merge_note:
            yield merge_note
    for issue in repair_issues(repository):
        yield intake_repair(issue, repository, apply=apply)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="permit PR publication, Kanban comments, and auto-merge requests")
    args = parser.parse_args(argv)
    try:
        messages = list(synchronize(apply=args.apply))
    except BridgeError as exc:
        print(f"BLOCKED: {exc}")
        return 0
    if messages:
        print("\n".join(messages))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
