#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Print a task's context pack: the slice of a PRD it needs. Exit 0 printed, 1 printed with a stale source, 2 usage or tool error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import context, interface, model  # noqa: E402


def _display_root(root: Path) -> str:
    root = root.resolve()
    try:
        return root.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return root.as_posix()


def main(argv: list[str]) -> int:
    return interface.run(_main, "context", argv)


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_context.py", description="Print the context pack a task needs from a PRD.")
    parser.add_argument("prd_dir", nargs="?")
    parser.add_argument("--area", help="the area slug (features/<area>.md); omit for the repo pack")
    parser.add_argument("--req", metavar="ID[,ID...]", help="only these UJ, FR or NFR blocks, plus the UJs they trace; an E-nnn adds its errors.md entry and the blocks it reaches")
    parser.add_argument("--for", dest="mode", choices=context.MODES, default="decide")
    parser.add_argument("--context", type=int, default=20, metavar="N", help="code lines either side of a Source line (implement)")
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
        print(f"prd_context: {bad}", file=sys.stderr)
        return 2
    if not args.prd_dir:
        parser.print_usage(sys.stderr)
        return 2
    if args.context < 0:
        print("prd_context: --context must be 0 or more", file=sys.stderr)
        return 2
    req = None if args.req is None else [i.strip().upper() for i in args.req.split(",") if i.strip()]

    try:
        prd = model.load(Path(args.prd_dir))
        items = context.build_pack(prd, args.area, req, args.mode, args.context, model.repo_root(prd.root), _display_root(prd.root))
    except (model.NotAPrd, context.ContextError) as e:
        print(f"prd_context: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_context: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    sys.stdout.write(context.render_document(prd, args.area, req, args.mode, items) if args.json else context.render_text(items))
    return 1 if any(i.stale and i.counted for i in items) else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
