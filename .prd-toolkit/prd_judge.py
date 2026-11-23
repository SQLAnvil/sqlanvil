#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Judge one judged test case: grade the output against its rubric N times, check every quote, compare the median score
with the threshold and record every run. Exit 0 pass, 1 fail, 2 the case could not be judged (usage, dependency or
internal error included)."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import judge, model  # noqa: E402


def _runs(v: str) -> int:
    n = int(v)
    if n < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return n


def _num(x: float) -> str:
    return f"{x:.4g}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_judge.py", description="Judge one judged test case with a model grader.")
    parser.add_argument("prd_dir")
    parser.add_argument("tid", metavar="T-id")
    parser.add_argument("output", help="the built output file to grade")
    parser.add_argument("--runs", type=_runs, help="gradings to run (overrides the case's runs:)")
    parser.add_argument("--model", help="the model of the default grader")
    parser.add_argument("--record-dir", help="where <T-id>.json goes (default <first test root>/.prd-judge/)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd_judge: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_judge: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if prd.adoption_unmigrated:
        print(f"prd_judge: {prd.root.as_posix()}/prd.md: {model.UNMIGRATED}", file=sys.stderr)
        return 2
    try:
        v = judge.judge(prd, args.tid, Path(args.output), args.runs, args.model,
                        Path(args.record_dir) if args.record_dir else None)
    except judge.CannotJudge as e:
        print(f"prd_judge: cannot judge {args.tid}: {e}", file=sys.stderr)
        if e.hint:
            print(f"prd_judge: hint: {e.hint}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_judge: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    print(f"{'pass' if v.passed else 'fail'} {v.tid} median {_num(v.median)} threshold {_num(v.threshold)}")
    if not v.passed:
        for item in v.median_run().items:
            if not item.counts:
                print(f"failed: {item.item}")
    return 0 if v.passed else 1


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
