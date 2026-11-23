#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Lint a PRD folder. Exit 0 clean, 1 violations, 2 usage, dependency or internal error."""
import argparse
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import interface, model, registry  # noqa: E402


def _display_root(root: Path) -> str:
    root = root.resolve()
    try:
        return root.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return root.as_posix()


class _OneLineUsage(argparse.HelpFormatter):
    """The usage line never wraps, whatever the terminal width (AC-004.1); the help text below it still does."""

    def _format_usage(self, *args, **kwargs):
        width, self._width = self._width, sys.maxsize
        try:
            return super()._format_usage(*args, **kwargs)
        finally:
            self._width = width


def main(argv: list[str]) -> int:
    argv, asked = interface.split_argv(argv)
    if "--interface" in argv:
        print(interface.INTERFACE)
        return 0
    problem = interface.check_version(asked)
    if problem:
        print(f"prd_lint: {problem}", file=sys.stderr)
        sys.stdout.write(interface.error("lint", problem))
        return 2
    return interface.run(_main, "lint", argv)


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_lint.py", description="Lint a PRD folder.", formatter_class=_OneLineUsage)
    parser.add_argument("prd_dir", nargs="?")
    parser.add_argument("--list-rules", action="store_true")
    parser.add_argument("--list-packs", action="store_true", help="print every pack on this machine, built-ins first")
    parser.add_argument("--ci", action="store_true", help="skip the checks that need this machine's skills and linters")
    parser.add_argument("--sample-tids", type=int, metavar="N")
    interface.add_flags(parser)
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2

    if args.list_rules:
        from prdlint import rules  # noqa: F401

        for name in sorted(registry.RULES):
            print(f"{name} {registry.SEVERITY.get(name, 'error')}")
        return 0
    if args.list_packs:
        from prdlint import packs

        for pack in packs.discover():
            about = f" — {pack.description}" if pack.description else ""
            print(f"{pack.name} {pack.version} ({pack.source}){about}")
        return 0
    if not args.prd_dir:
        parser.print_usage(sys.stderr)
        return 2

    if args.sample_tids is not None and args.sample_tids < 0:
        print("prd_lint: --sample-tids N must be >= 0", file=sys.stderr)
        return 2

    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd_lint: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_lint: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    if args.sample_tids is not None:
        # unit cases stay with the builder (they read code); only the other levels are dry-run
        levels = [(t, str(t.data.get("level", "")).strip()) for t in prd.test_cases]
        if all(lv == "unit" for _, lv in levels):
            print("prd_lint: no non-unit T-ids to sample", file=sys.stderr)
            return 1
        # level names are lowercase only: a case with no level, or one such as `Unit`, is lint's test-level finding
        cases = [t for t, lv in levels if lv and lv == lv.lower() and lv != "unit"]
        # each line names the test-case file, so the tester opens the right one
        for t in random.sample(cases, min(args.sample_tids, len(cases))):
            print(f"{t.id} {t.file}")
        return 0

    if args.ci:
        os.environ["PRD_LINT_CI"] = "1"
    try:
        findings = registry.run(prd, warnings=True)
    except registry.RuleCrash as e:
        print(f"prd_lint: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_lint: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    prefix = _display_root(prd.root)
    if args.json:
        errors = sum(1 for f in findings if f.severity != "warn")
        sys.stdout.write(interface.dump("lint", {
            "prd": prd.frontmatter.get("prd"),
            "version": prd.frontmatter.get("version"),
            "dir": prefix,
            "findings": [{"file": f.file, "line": f.line, "rule": f.rule, "severity": "warn" if f.severity == "warn" else "error", "message": f.message} for f in findings],
            "errors": errors,
            "warnings": len(findings) - errors,
        }))
        return 1 if errors else 0
    for f in findings:
        print(f"{os.path.join(prefix, f.file)}:{f.line}: {'warn: ' if f.severity == 'warn' else ''}{f.rule}: {f.message}" if prefix != "." else str(f))
    return 1 if any(f.severity != "warn" for f in findings) else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # PRDs carry em dashes; never crash in a C locale
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
