"""Logic of the commit-msg and pre-commit git hooks (the shell shims call prd_git_hook.py)."""
import shlex
import subprocess
from pathlib import Path

from . import standardsrun, trace
from .model import Prd
from .rules import registries


def commit_msg(prd: Prd, repo_root: Path, message: str, staged: list[str], merging: bool) -> list[str]:
    """Problems with the commit message; [] for a merge commit or when nothing staged is under the commit rule."""
    if merging:
        return []
    text = "\n".join(line for line in message.splitlines() if not line.startswith("#"))
    code = any(map(trace.outside_prd(prd, repo_root), staged))
    inside = trace.in_boundary(prd, repo_root)
    trailer = trace.changeset_problems(prd, text)  # every commit, inside the Boundary or not
    if not any(inside(f) for f in staged):
        # outside the Boundary no `Refs:` is required, but a code commit still may not cite an
        # unconfirmed entry (as `prd_error.py check` judges every path outside the PRD folder)
        return (trace.unconfirmed_refs(prd, text) if code else []) + trailer
    return trace.refs_problems(prd, text, code_commit=code) + trailer


def pre_commit(prd: Prd, repo_root: Path, staged: list[str]) -> list[str]:
    """Run each enforced standards row on the staged files its glob matches, in its files mode; one problem per failing row."""
    problems = []
    for row in registries.standards_rows(prd):
        if row.decision != "enforced" or not row.command:
            continue
        files = standardsrun.hook_paths(staged, trace.glob_re(row.glob))
        if not files:
            continue
        given = [] if standardsrun.run_mode(row.mode) == "none" else files  # `none`: once, with no path (AC-264.4)
        try:
            argv = shlex.split(row.command) + given
            r = subprocess.run(argv, cwd=repo_root, capture_output=True, text=True, encoding="utf-8", errors="replace")
        except (OSError, ValueError) as e:
            problems.append(f"`{row.command}` could not run: {e}")
            continue
        if r.returncode != 0:
            out = (r.stdout + r.stderr).strip()
            on = f" on {', '.join(given)}" if given else ""  # no ` on <paths>` for a run with no path (AC-264.5)
            problems.append(f"`{row.command}` failed (exit {r.returncode}){on}" + (f":\n{out}" if out else ""))
    return problems
