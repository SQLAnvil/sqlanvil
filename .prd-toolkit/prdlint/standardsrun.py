"""Which paths a section 5 standards row runs on: never the vendored copy (FR-068), in the row's files mode (FR-264)."""
import re
import shlex

VENDOR_DIR = ".prd-toolkit"  # the vendored copy's folder at the repository root (hooks.VENDOR_DIR)
MODES = ("appended", "none", "changed")  # the files modes a row may name (AC-264.1)
DEFAULT_MODE = "appended"
BASE = "@BASE@"  # the merge request's base commit in a `changed` row's job, filled in by each CI renderer (AC-264.3)


def files_mode(cell: str) -> str:
    """The row's files mode as written (AC-264.1): the rest of its second backticked span, stripped, when that span starts
    with `files:`; `appended` when the cell has no second span or it does not start with `files:`. Not checked here."""
    spans = re.findall(r"`([^`]*)`", cell)
    if len(spans) < 2:
        return DEFAULT_MODE
    text = spans[1].strip()
    return text[len("files:"):].strip() if text.startswith("files:") else DEFAULT_MODE


def run_mode(mode: str) -> str:
    """The mode a row runs in: a mode that is not one of MODES runs as `appended` (AC-264.1)."""
    return mode if mode in MODES else DEFAULT_MODE


def vendored(path: str) -> bool:
    """True for the vendored copy: the path `.prd-toolkit` itself or one under `.prd-toolkit/`, relative to the root."""
    return path == VENDOR_DIR or path.startswith(VENDOR_DIR + "/")


def hook_paths(staged: list[str], rx) -> list[str]:
    """The paths the pre-commit hook gives a row's linter: each staged path its glob matches, the vendored copy left out;
    a path starting with `-` is passed as ./<path>, so it cannot read as an option."""
    return [("./" + f) if f.startswith("-") else f for f in staged if rx.match(f) and not vendored(f)]


def ci_command(glob: str, command: str, mode: str = DEFAULT_MODE) -> str:
    """The job `standards-<n>`'s one command, by the row's files mode: `appended` gives the command the tracked files the
    glob matches, outside the vendored copy, as ./<path> (AC-068.4); `none` runs it once with no path when any such file
    exists (AC-264.2); `changed` gives it the matching files changed since BASE, deleted ones left out (AC-264.3)."""
    pathspec = f"-- {shlex.quote(':(glob)' + glob)} ':(exclude){VENDOR_DIR}'"
    mode = run_mode(mode)
    if mode == "none":
        return f'if [ -n "$(git ls-files {pathspec})" ]; then {command}; fi'
    if mode == "changed":
        return f"git diff -z --name-only --diff-filter=d --line-prefix=./ {BASE}...HEAD {pathspec} | xargs -0 -r {command}"
    return f"git ls-files -z --format='./%(path)' {pathspec} | xargs -0 -r {command}"
