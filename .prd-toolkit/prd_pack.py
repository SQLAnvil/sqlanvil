#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Compare two PRDs for a pack, and check a pack written from them. Exit 0 done, 1 nothing shared or findings, 2 usage or tool error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import interface, model, packcheck, packcompare  # noqa: E402

KINDS = {"compare": "pack.compare", "check": "pack.check"}  # the document kind of each subcommand; `pack` for none


class _OneLineUsage(argparse.HelpFormatter):
    """The usage line never wraps, whatever the terminal width; the help text below it still does."""

    def _format_usage(self, *args, **kwargs):
        width, self._width = self._width, sys.maxsize
        try:
            return super()._format_usage(*args, **kwargs)
        finally:
            self._width = width


def _flags(parser: argparse.ArgumentParser, leaf: bool) -> None:
    """--json and --interface on the top parser and each subcommand; a subcommand that does not see them leaves the
    top value alone."""
    interface.add_flags(parser)
    if leaf:
        for a in parser._actions:
            if a.dest in ("json", "interface"):
                a.default = argparse.SUPPRESS


def _build() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prd_pack.py", formatter_class=_OneLineUsage, allow_abbrev=False,
                                     description="Compare two PRDs for a pack, and check a pack written from them.")
    _flags(parser, leaf=False)
    sub = parser.add_subparsers(dest="cmd", metavar="{compare,check}", required=True)
    cmp = sub.add_parser("compare", formatter_class=_OneLineUsage, allow_abbrev=False,
                         help="print what two PRD folders share, part by part")
    cmp.add_argument("prd_a", help="the first PRD folder, A")
    cmp.add_argument("prd_b", help="the second PRD folder, B")
    _flags(cmp, leaf=True)
    chk = sub.add_parser("check", formatter_class=_OneLineUsage, allow_abbrev=False,
                         help="check a pack folder against the two PRD folders it was written from")
    chk.add_argument("pack_dir", help="the pack folder, the one holding pack.yaml")
    chk.add_argument("prd_a", help="the first PRD folder, A")
    chk.add_argument("prd_b", help="the second PRD folder, B")
    _flags(chk, leaf=True)
    return parser


def main(argv: list[str]) -> int:
    argv, asked = interface.split_argv(argv)
    if "--interface" in argv:  # whatever else is given, no subcommand included, and no --json=N checked (AC-058.4)
        print(interface.INTERFACE)
        return 0
    kind = interface.subcommand_kind(argv, KINDS, "pack")
    problem = interface.check_version(asked)
    if problem:  # refused before a folder is read (AC-058.4)
        print(f"prd_pack: {problem}", file=sys.stderr)
        sys.stdout.write(interface.error(kind, problem))
        return 2
    return interface.run(_main, kind, argv)


def _internal(e: Exception) -> int:
    print(f"prd_pack: internal error: {type(e).__name__}: {e}", file=sys.stderr)
    return 2


def _main(argv: list[str]) -> int:
    parser = _build()
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    try:
        a, b = model.load(Path(args.prd_a)), model.load(Path(args.prd_b))
    except model.NotAPrd as e:
        print(f"prd_pack: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        return _internal(e)
    try:
        return _compare(args, a, b) if args.cmd == "compare" else _check(args, a, b)
    except Exception as e:
        return _internal(e)


def _compare(args, a: model.Prd, b: model.Prd) -> int:
    try:
        parts = packcompare.compare(a, b)
    except packcompare.NothingShared:
        message = f"{args.prd_a} and {args.prd_b} share no custom contract type; there is no pack to write"
        print(f"prd_pack: {message}", file=sys.stderr)
        if args.json:
            sys.stdout.write(interface.error(KINDS["compare"], message))
        return 1
    if args.json:
        sys.stdout.write(interface.dump(KINDS["compare"], packcompare.document(args.prd_a, args.prd_b, parts)))
    else:
        sys.stdout.write(packcompare.text(parts))
    return 0


def _check(args, a: model.Prd, b: model.Prd) -> int:
    findings = packcheck.check(args.pack_dir, [(args.prd_a, a.root), (args.prd_b, b.root)])
    if args.json:
        sys.stdout.write(interface.dump(KINDS["check"], {"findings": [packcheck.split(f) for f in findings]}))
    else:
        sys.stdout.write("".join(f"{f}\n" for f in findings))
    return 1 if findings else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # PRDs carry em dashes; never crash in a C locale
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
