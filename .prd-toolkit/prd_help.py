#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Print what a field of the PRD grammar or a lint rule is, as text or JSON. Exit 0 answered, 2 cannot answer."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import helpcat, interface  # noqa: E402

KIND = "help"


class _OneLineUsage(argparse.HelpFormatter):
    """The usage line never wraps, whatever the terminal width (AC-036.2); the help text below it still does."""

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
        print(f"prd_help: {problem}", file=sys.stderr)
        sys.stdout.write(interface.error(KIND, problem))
        return 2
    return interface.run(_main, KIND, argv)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prd_help.py", description="Print what a field of the PRD grammar or a lint rule is.",
                                     formatter_class=_OneLineUsage)
    one = parser.add_mutually_exclusive_group()
    one.add_argument("--key", help="print the catalogue entry with that key")
    one.add_argument("--rule", help="print that lint rule and the entries that name it")
    interface.add_flags(parser)
    return parser


def _index(entries: list[dict], rules: dict) -> list[str]:
    return [f"{e['key']}  {e['name']}" for e in entries] + [""] + [f"{name}  {r['severity']}" for name, r in rules.items()]


def _entry_text(entry: dict, rules: dict) -> list[str]:
    lines = [f"{entry['name']} ({entry['key']})", f"What: {entry['what']}", f"Why: {entry['why']}"]
    if entry.get("rules"):
        lines += ["Rules:", *(f"- {r}" for r in entry["rules"])]
    if entry.get("checked_by"):
        lines += ["Checked by:", *(f"- {r}: {rules[r]['description']}" for r in entry["checked_by"])]
    if "see" in entry:
        lines.append(f"See: {entry['see']}")
    return lines


def _rule_text(name: str, rule: dict, entries: list[dict]) -> list[str]:
    lines = [f"{name} ({rule['severity']})", rule["description"]]
    keys = [e["key"] for e in helpcat.checks(entries, name)]
    if keys:
        lines.append("Checks: " + ", ".join(keys))
    return lines


def _main(argv: list[str]) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    try:
        entries = helpcat.load()
    except helpcat.CatalogueError as e:
        print(f"prd_help: {e}", file=sys.stderr)
        return 2
    rules = helpcat.rules()
    if args.key is not None:
        entry = next((e for e in entries if e["key"] == args.key), None)
        if entry is None:
            print(f"prd_help: no entry '{args.key}'", file=sys.stderr)
            return 2
        entries, text = [entry], _entry_text(entry, rules)
    elif args.rule is not None:
        if args.rule not in rules:
            print(f"prd_help: no rule '{args.rule}'", file=sys.stderr)
            return 2
        text = _rule_text(args.rule, rules[args.rule], entries)
        entries, rules = helpcat.checks(entries, args.rule), {args.rule: rules[args.rule]}
    else:
        text = _index(entries, rules)
    if args.json:
        sys.stdout.write(interface.dump(KIND, {"entries": entries, "rules": rules}))
    else:
        sys.stdout.write("".join(f"{line}\n" for line in text))
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # the catalogue carries dashes outside ASCII; never crash in a C locale
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
