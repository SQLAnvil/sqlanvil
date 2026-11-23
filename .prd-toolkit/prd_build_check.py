#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""The build's mechanical checks: --diff (builder edits), --results (tester RESULTS) and --stale (a test case changed after its test). Exit 0 clean, 1 findings, 2 usage, dependency or internal error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import buildcheck, model, trace  # noqa: E402


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_build_check.py", description="Mechanical checks for a build round.")
    parser.add_argument("prd_dir", nargs="?")
    parser.add_argument("--diff", metavar="BASE..HEAD", help="fail PRD-folder edits and edits to a tester's test")
    parser.add_argument("--sources", metavar="FILE", help="with --diff: hold a builder's SOURCES lines to the round's hunks")
    parser.add_argument("--results", metavar="REPORT", help="check a tester report's RESULTS block")
    parser.add_argument("--stale", action="store_true", help="list dispatched T-ids whose test case changed after their test")
    parser.add_argument("--tids", help="comma-separated T-ids dispatched (with --results or --stale)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if not args.prd_dir or [bool(args.diff), bool(args.results), args.stale].count(True) != 1 or (
            (args.results or args.stale) and not args.tids) or (args.sources and not args.diff):
        parser.print_usage(sys.stderr)
        print("prd_build_check: give exactly one of --diff, --results (with --tids) or --stale (with --tids); --sources goes with --diff", file=sys.stderr)
        return 2
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd_build_check: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_build_check: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if prd.adoption_unmigrated:
        print(f"prd_build_check: {prd.root.as_posix()}/prd.md: {model.UNMIGRATED}", file=sys.stderr)
        return 2
    try:
        if args.diff:
            findings = buildcheck.diff_findings(prd, model.repo_root(prd.root), args.diff)
            if args.sources:
                findings += buildcheck.sources_findings(
                    model.repo_root(prd.root), args.diff, Path(args.sources).read_text(encoding="utf-8"))
        elif args.stale:
            if model.git_toplevel(prd.root) is None:
                print(f"prd_build_check: {prd.root.as_posix()} is not in a git working tree", file=sys.stderr)
                return 2
            findings = buildcheck.stale_findings(prd, model.repo_root(prd.root), [t.strip() for t in args.tids.split(",") if t.strip()])
        else:
            findings = buildcheck.results_findings(
                Path(args.results).read_text(encoding="utf-8"), [t.strip() for t in args.tids.split(",") if t.strip()])
    except buildcheck.ToolError as e:
        print(f"prd_build_check: {e}", file=sys.stderr)
        return 2
    except trace.BadRange as e:
        print(f"prd_build_check: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_build_check: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    for f in findings:
        print(f)
    return 1 if findings else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
