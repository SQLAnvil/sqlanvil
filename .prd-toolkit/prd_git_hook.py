#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Git hook logic. `commit-msg <prd-folder> <message-file>` or `pre-commit <prd-folder>`. Exit 0 allow, 1 block, 2 usage or tool error (also blocks)."""
import argparse
import os
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import githook, model  # noqa: E402

ACCEPTED = "prd-toolkit: accepted forms: Refs: FR-001, E-002 | Refs: none (no behaviour change)"


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, check=True, encoding="utf-8").stdout


def _staged(root: Path) -> tuple[list[str], list[str]]:
    """(every path in the index diff, incl. deletions and rename sources; paths that exist after the commit: A/C/M/R destinations)."""
    out = subprocess.run(["git", "diff", "--cached", "--name-status", "-z", "-M"], cwd=root, capture_output=True, check=True).stdout
    tokens = [t.decode("utf-8", "surrogateescape") for t in out.split(b"\0")]
    allp: list[str] = []
    live: list[str] = []
    i = 0
    while i < len(tokens) and tokens[i]:
        status = tokens[i][0]
        n = 2 if status in "RC" else 1
        paths = tokens[i + 1:i + 1 + n]
        allp += paths
        if status != "D":
            live.append(paths[-1])
        i += 1 + n
    return allp, live


def _merging(root: Path) -> bool:
    path = Path(_git(root, "rev-parse", "--git-path", "MERGE_HEAD").strip())
    return (path if path.is_absolute() else root / path).exists()


def _pin_work_tree() -> None:
    """Git starts a hook at the top of the work tree and may export GIT_DIR (absolute in a linked worktree,
    possibly relative in the main checkout) without GIT_WORK_TREE. Every git call below runs from another
    directory (the PRD folder, the repo root), where that GIT_DIR alone would make git take the call's own
    directory for the top of the work tree. So pin both, from the hook's own directory, before any git call."""
    git_dir = os.environ.get("GIT_DIR")
    if not git_dir or os.environ.get("GIT_WORK_TREE"):
        return
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, check=True, encoding="utf-8").stdout.strip()
    os.environ["GIT_DIR"] = str(Path(git_dir).resolve())
    os.environ["GIT_WORK_TREE"] = top


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_git_hook.py", description="Logic of the PRD git hooks.")
    sub = parser.add_subparsers(dest="hook")
    cm = sub.add_parser("commit-msg")
    cm.add_argument("prd_dir")
    cm.add_argument("message_file")
    pc = sub.add_parser("pre-commit")
    pc.add_argument("prd_dir")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if not args.hook:
        parser.print_usage(sys.stderr)
        return 2
    try:
        _pin_work_tree()
    except Exception as e:
        print(f"prd-toolkit: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd-toolkit: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd-toolkit: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if prd.adoption_unmigrated:
        print(f"prd-toolkit: {prd.root.as_posix()}/prd.md: {model.UNMIGRATED}", file=sys.stderr)
        return 2
    try:
        root = model.repo_root(prd.root)
        staged, live = _staged(root)
        if args.hook == "commit-msg":
            message = Path(args.message_file).read_text(encoding="utf-8", errors="replace")
            problems = githook.commit_msg(prd, root, message, staged, _merging(root))
        else:
            problems = githook.pre_commit(prd, root, live)
    except Exception as e:
        print(f"prd-toolkit: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    for problem in problems:
        print(f"prd-toolkit: {problem}", file=sys.stderr)
    if problems and args.hook == "commit-msg":
        print(ACCEPTED, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
