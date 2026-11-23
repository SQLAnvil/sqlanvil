#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Compare what each environment runs with what the PRD says. Exit 0 no drift, 1 drift, 2 usage or tool error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import drift, model  # noqa: E402


def _fail(message: str) -> int:
    print(f"prd_drift: {message}", file=sys.stderr)
    return 2


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_drift.py", description="Compare each environment with the PRD's Drift table.")
    parser.add_argument("prd_dir")
    parser.add_argument("--env", metavar="ENV", help="check only this environment")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        return _fail(str(e))
    except Exception as e:
        return _fail(f"internal error: {type(e).__name__}: {e}")
    if prd.adoption_unmigrated:
        return _fail(f"{prd.root.as_posix()}/prd.md: {model.UNMIGRATED}")
    envs = sorted({r.env for r in prd.operations.drift})
    if args.env is not None and args.env not in envs:
        return _fail(f"no Drift rows for {args.env!r}; environments with rows: {', '.join(envs) or 'none'}")
    try:
        findings, errors = drift.drift_findings(prd, model.repo_root(prd.root), args.env)
    except Exception as e:
        return _fail(f"internal error: {type(e).__name__}: {e}")
    if errors:
        for f in findings:
            print(f, file=sys.stderr)
        for e in errors:
            print(e, file=sys.stderr)
        return 2
    for f in findings:
        print(f)
    return 1 if findings else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
