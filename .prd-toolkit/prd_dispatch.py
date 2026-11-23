#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["openapi-spec-validator>=0.7", "pyyaml>=6.0", "sqlglot>=25"]
# ///
"""Run one prd-toolkit script by its command name. Exit 2 on an unknown command; otherwise the script's own exit code."""
import ast
import json
import os
import sys
from pathlib import Path

_NAMES = (
    "block", "build-check", "change", "confirm", "context", "deploy", "drift", "error", "gates",
    "git-hook", "help", "hooks", "judge", "links", "lint", "pack", "practices", "publish", "status", "trace",
)
COMMANDS = {name: f"prd_{name.replace('-', '_')}.py" for name in _NAMES}
PLUGIN_ONLY = ("publish",)  # commands whose script install never vendors


def _summary(script: Path) -> str:
    """The first line of the script's docstring, read without importing it."""
    try:
        doc = ast.get_docstring(ast.parse(script.read_text()))
    except (OSError, SyntaxError, ValueError):
        doc = None
    return doc.splitlines()[0] if doc else ""


def _version(here: Path) -> str:
    vendored = here / "VERSION"
    if vendored.is_file():
        return vendored.read_text().strip()
    return json.loads((here.parent / ".claude-plugin/plugin.json").read_text())["version"]


def _help(here: Path) -> str:
    """The usage line, then the commands whose script is beside the dispatcher (a vendored copy has no publish)."""
    lines = ["usage: prd <command> [arguments]"]
    present = sorted(name for name, script in COMMANDS.items() if (here / script).is_file())
    width = max(map(len, present), default=0)
    for name in present:
        lines.append(f"{name.ljust(width)}  {_summary(here / COMMANDS[name])}".rstrip())
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    here = Path(__file__).resolve().parent
    if not argv or argv[0] in ("-h", "--help"):
        sys.stdout.write(_help(here))
        return 0
    if argv[0] == "--version":
        print(_version(here))
        return 0
    script = COMMANDS.get(argv[0])
    if script is None:
        sys.stderr.write(f"prd: unknown command '{argv[0]}'\ncommands: {', '.join(sorted(COMMANDS))}\n")
        return 2
    path = here / script
    if not path.is_file() and argv[0] in PLUGIN_ONLY and (here / "VERSION").is_file():  # VERSION: a vendored copy
        sys.stderr.write(f"prd: {argv[0]} runs from the plugin, not from a vendored copy\n")
        return 2
    if not path.is_file():
        sys.stderr.write(f"prd: {script} is not in {here}; run prd_hooks.py install\n")
        return 2
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(sys.executable, [sys.executable, str(path), *argv[1:]])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
