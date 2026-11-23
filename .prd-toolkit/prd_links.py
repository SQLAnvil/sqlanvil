#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Links between PRDs in different repositories: add, sync, check, impact, and changeset (the change-set record's only writer).

Exit 0 done or clean; 1 refused (`refused: <why>` on stderr) or drift, and for impact only a consumer citing a changed
item; 2 usage or tool error (`prd_links: <why>`): git that cannot run, in every command, and impact's own refusal or
failure; 3 (check and impact) nothing drifted but a side was unreachable. `check --ci` exits 0 there, after printing the
unreachable line, and prints each drift line between two members of an open change set as
`drift allowed by <start-prd>/CS-nnn: <line>`, which does not count toward exit 1.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import changeset, links, model  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prd_links.py", description="Link PRDs across repositories.")
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    p = sub.add_parser("add", help="add an Upstreams row here and the Consumers row in the upstream")
    p.add_argument("prd_dir", metavar="PRD")
    p.add_argument("location", help="a path to the other repository's root, or <git URL>#<PRD folder>")
    p.add_argument("--needs", default="", help="verified, or live in <env> (empty: the default)")
    p = sub.add_parser("sync", help="copy the cited upstream items into the snapshot and write the lock")
    p.add_argument("prd_dir", metavar="PRD")
    p.add_argument("upstream")
    p.add_argument("--ref", help="the upstream ref to copy from (default: its default branch)")
    p = sub.add_parser("check", help="compare every snapshot with the other side, and the rows on both sides")
    p.add_argument("prd_dir", metavar="PRD")
    p.add_argument("--ref", help="the ref to read each upstream at (default: its default branch); consumers are read at theirs")
    p.add_argument("--ci", action="store_true", help="exit 0 where an unreachable side alone would exit 3; drift between members of an open change set is allowed")
    p = sub.add_parser("impact", help="the contract items this working tree changes, and the consumers that cite them")
    p.add_argument("prd_dir", metavar="PRD")
    p.add_argument("--base", default="HEAD", help="the ref to compare the working tree with (default: HEAD)")
    cs = sub.add_parser("changeset", help="write a change-set record, changes/CS-nnn.md").add_subparsers(dest="action", metavar="<action>")
    p = cs.add_parser("new", help="number a record and write every member in Order, Status proposed")
    p.add_argument("prd_dir", metavar="PRD")
    p.add_argument("--title", required=True)
    p.add_argument("--member", action="append", default=[], help="a path to a member repository's root (repeat for each)")
    p = cs.add_parser("set", help="set a row's branch, version, ids or state")
    p.add_argument("record")
    p.add_argument("prd")
    p.add_argument("fields", nargs="+", metavar="<field>=<value>")
    p = cs.add_parser("approve", help="record the user's approval reply; proposed rows and Status become approved")
    p.add_argument("record")
    p.add_argument("--reply", required=True)
    p.add_argument("--amendment", action="store_true")
    p = cs.add_parser("stop", help="record a stop on Status and in Log")
    p.add_argument("record")
    p.add_argument("prd")
    p.add_argument("reason")
    p = cs.add_parser("log", help="add a line to Log")
    p.add_argument("record")
    p.add_argument("text")
    p = cs.add_parser("close", help="Status done and the Merge order, once every State equals its Target")
    p.add_argument("record")
    p = cs.add_parser("abandon", help="Status abandoned; the branches are left for the user")
    p.add_argument("record")
    p.add_argument("reason")
    return parser


def _changeset(args) -> Path:
    if args.action == "set":
        return changeset.set_fields(args.record, args.prd, args.fields)
    if args.action == "approve":
        return changeset.approve(args.record, args.reply, args.amendment)
    if args.action == "stop":
        return changeset.stop(args.record, args.prd, args.reason)
    if args.action == "log":
        return changeset.log(args.record, args.text)
    if args.action == "close":
        return changeset.close(args.record)
    return changeset.abandon(args.record, args.reason)


def main(argv: list[str]) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if not args.command:
        parser.print_usage(sys.stderr)
        print("prd_links: give a command", file=sys.stderr)
        return 2
    if args.command == "changeset" and not args.action:
        parser.print_usage(sys.stderr)
        print("prd_links: changeset: give new, set, approve, stop, log, close or abandon", file=sys.stderr)
        return 2
    if args.command == "changeset" and args.action != "new":
        return _run(lambda: ([str(_changeset(args))], 0))
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd_links: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_links: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if prd.adoption_unmigrated:
        print(f"prd_links: {prd.root.as_posix()}/prd.md: {model.UNMIGRATED}", file=sys.stderr)
        return 2
    return _run(lambda: _command(args, prd))


def _command(args, prd: model.Prd) -> tuple[list[str], int]:
    """A command on a loaded PRD: its report lines and exit code."""
    if args.command == "changeset":
        return [str(changeset.new(prd, args.title, args.member))], 0
    if args.command == "add":
        return links.add(prd, args.location, args.needs), 0
    if args.command == "sync":
        return links.sync(prd, args.upstream, args.ref), 0
    if args.command == "check":
        lines = links.check(prd, args.ref)
        if not args.ci:
            return [str(x) for x in lines], links.check_exit(lines)
        marked = links.let_through(prd, links.toplevel(prd.root), lines)  # R-F2: an open change set's drift
        code = links.check_exit([x for x, by in marked if by is None])
        return [links.allowed(by, x) if by else str(x) for x, by in marked], 0 if code == 3 else code
    try:
        changed, cited, unreachable = links.impact(prd, args.base)
    except (links.Refused, links.Unreachable) as e:  # exit 1 means a consumer cites a changed item: never a refusal
        raise _ToolError(str(e)) from None
    report = ([f"changed: {x}" for x in changed] + [f"consumer {c}: {x}" for c in sorted(cited) for x in cited[c]]
              + [f"consumer {c}: unreachable" for c in unreachable])
    return report, 1 if cited else 3 if unreachable else 0


class _ToolError(Exception):
    """A failure that is not a refusal: exit 2, `prd_links: <why>` on stderr."""


def _run(command) -> int:
    """Run `command` (returning its report lines and exit code), print the report, and map the errors to exit codes."""
    try:
        report, code = command()
    except (links.BadArgument, links.GitMissing, _ToolError) as e:
        print(f"prd_links: {e}", file=sys.stderr)
        return 2
    except (links.Refused, links.Unreachable) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"prd_links: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    for line in report:
        print(line)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
