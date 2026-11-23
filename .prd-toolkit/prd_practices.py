#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""List the sources and practices of a PRD's practices.md. Exit 0 listed, 2 usage or tool error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import interface, model, practices  # noqa: E402

KIND = "practices"


class _OneLineUsage(argparse.HelpFormatter):
    """The usage line never wraps, whatever the terminal width (AC-052.2); the help text below it still does."""

    def _format_usage(self, *args, **kwargs):
        width, self._width = self._width, sys.maxsize
        try:
            return super()._format_usage(*args, **kwargs)
        finally:
            self._width = width


def main(argv: list[str]) -> int:
    argv, asked = interface.split_argv(argv)
    if "--interface" in argv:  # whatever else is given, no folder included, and no --json=N checked (AC-051.4)
        print(interface.INTERFACE)
        return 0
    problem = interface.check_version(asked)
    if problem:  # refused before the folder is read (AC-052.5)
        print(f"prd_practices: {problem}", file=sys.stderr)
        sys.stdout.write(interface.error(KIND, problem))
        return 2
    return interface.run(_main, KIND, argv)


def _main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_practices.py", formatter_class=_OneLineUsage, allow_abbrev=False,
                                     description="List the sources and practices of a PRD's practices.md.")
    parser.add_argument("prd_dir", help="the PRD folder; it comes before --paths")
    parser.add_argument("--paths", nargs="+", metavar="PATH",
                        help="print only the code practices whose glob matches one or more of these paths, "
                             "each relative to the repository root, as written")
    interface.add_flags(parser)
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    try:
        prd = model.load(Path(args.prd_dir))
        rec = practices.load(prd)
    except model.NotAPrd as e:
        print(f"prd_practices: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_practices: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    listed = rec.practices if args.paths is None else practices.matching(rec.practices, args.paths)
    if args.json:
        sys.stdout.write(interface.dump(KIND, {"sources": [practices.source_dict(s) for s in rec.sources],
                                               "practices": [practices.practice_dict(p) for p in listed]}))
        return 0
    lines = [practices.source_line(s) for s in rec.sources] if args.paths is None else []
    lines += [practices.practice_line(p) for p in listed]
    sys.stdout.write("".join(f"{line}\n" for line in lines))
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # practices.md may hold text outside ASCII; never crash in a C locale
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
