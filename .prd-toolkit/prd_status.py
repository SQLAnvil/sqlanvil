#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Print where every requirement of a PRD stands. Exit 0 printed, 2 usage or tool error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import interface, model, nextpart, status  # noqa: E402


def _display_root(root: Path) -> str:
    root = root.resolve()
    try:
        return root.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return root.as_posix()


def main(argv: list[str]) -> int:
    return interface.run(_main, "status", argv)


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_status.py", description="Print the status report of a PRD.")
    parser.add_argument("prd_dir", nargs="?")
    interface.add_flags(parser)
    try:
        argv, asked = interface.split_argv(argv)
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if args.interface:
        print(interface.INTERFACE)
        return 0
    bad = interface.check_version(asked)
    if bad:
        print(f"prd_status: {bad}", file=sys.stderr)
        return 2
    if not args.prd_dir:
        parser.print_usage(sys.stderr)
        return 2
    try:
        prd = model.load(Path(args.prd_dir))
        if prd.adoption_unmigrated:
            print(f"prd_status: {prd.root.as_posix()}/prd.md: {model.UNMIGRATED}", file=sys.stderr)
            return 2
        repo_root = model.repo_root(prd.root)
        items = status.build_status(prd, repo_root, _display_root(prd.root))
        upcoming = nextpart.next_items(prd, repo_root, items)
    except model.NotAPrd as e:
        print(f"prd_status: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_status: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if args.json:
        sys.stdout.write(status.render_document(prd, items, [i.to_dict() for i in upcoming]))
    else:
        sys.stdout.write(nextpart.render_text(upcoming) + status.render_text(items))
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
