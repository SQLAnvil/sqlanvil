"""Which paths a section 5 standards row runs on: never the vendored copy (FR-068)."""
import shlex

VENDOR_DIR = ".prd-toolkit"  # the vendored copy's folder at the repository root (hooks.VENDOR_DIR)


def vendored(path: str) -> bool:
    """True for the vendored copy: the path `.prd-toolkit` itself or one under `.prd-toolkit/`, relative to the root."""
    return path == VENDOR_DIR or path.startswith(VENDOR_DIR + "/")


def hook_paths(staged: list[str], rx) -> list[str]:
    """The paths the pre-commit hook gives a row's linter: each staged path its glob matches, the vendored copy left out;
    a path starting with `-` is passed as ./<path>, so it cannot read as an option."""
    return [("./" + f) if f.startswith("-") else f for f in staged if rx.match(f) and not vendored(f)]


def ci_command(glob: str, command: str) -> str:
    """The job `standards-<n>`'s one command: the tracked files the glob matches, outside the vendored copy, as ./<path>."""
    return f"git ls-files -z --format='./%(path)' -- {shlex.quote(':(glob)' + glob)} ':(exclude){VENDOR_DIR}' | xargs -0 -r {command}"
