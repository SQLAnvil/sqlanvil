#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""The errors.md ledger: new, list, propose, confirm, resolve, url, check. Exit 0 done, 1 refused, 2 usage, dependency or internal error."""
import argparse
import os
import re
import signal
import sys
from collections import Counter
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import deploy, errorreplay, errors, interface, model, registry, trace  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="prd_error.py", description="Write the errors.md ledger of a PRD.")
    sub = p.add_subparsers(dest="cmd", required=True)

    def cmd(name: str, eid: bool = True) -> argparse.ArgumentParser:
        c = sub.add_parser(name)
        c.add_argument("prd_dir")
        if eid:
            c.add_argument("eid")
        return c

    c = sub.add_parser("check", help="every change to errors.md in <base>..<head>: findings on stdout, exit 1 when any")
    c.add_argument("prd_dir")
    c.add_argument("range")
    c = cmd("new", False)
    c.add_argument("--title", required=True)
    c.add_argument("--source", required=True)
    c.add_argument("--touches", default="")
    c.add_argument("--evidence-file")
    c.add_argument("--url", help="write the line URL: <address> after Touches:, or after Classification: with no Touches:")
    c = cmd("list", False)
    c.add_argument("--open", action="store_true")
    c = cmd("propose")
    c.add_argument("--class", dest="cls", required=True)
    c.add_argument("--diagnosis", required=True)
    c.add_argument("--recurrence")
    c.add_argument("--touches", default="")
    c = cmd("confirm")
    c.add_argument("--reply", required=True)
    c.add_argument("--class", dest="cls")
    c = cmd("resolve")
    c.add_argument("--t")
    c.add_argument("--version")
    c.add_argument("--commit")
    c.add_argument("--run")
    c.add_argument("--not-a-defect", dest="not_a_defect")
    c.add_argument("--red-run", dest="red_run", help="the test id the level's One test command takes; with --commit and --level only")
    c.add_argument("--level", help="a build-gate level of testing.md Levels with a One test command; with --red-run only")
    c = cmd("url")
    c.add_argument("address", help="the entry's URL, or - to remove its URL: line")
    c = cmd("replay")
    c.add_argument("--timeout", help="seconds for every run, a whole number of at least 1")
    interface.add_flags(c)
    return p


def _level(prd: model.Prd, tid: str) -> str:
    for tc in prd.test_cases:
        if tc.id == tid:
            level = tc.data.get("level")
            if level:
                return str(level)
            raise deploy.Refused([f"{tid} has no level in its test case"])
    raise deploy.Refused([f"{tid} has no test case"])


def _run(args: argparse.Namespace, prd: model.Prd, today: date) -> list[str]:
    if args.cmd == "new":
        evidence = Path(args.evidence_file).read_text(encoding="utf-8").splitlines() if args.evidence_file else []
        touches = errors.parse_touches(args.touches)
        return [errors.new(prd, args.title, args.source, touches, evidence, today, args.url)]
    if args.cmd == "check":
        return errors.check_findings(prd, model.repo_root(prd.root), args.range)
    if args.cmd == "list":
        return errors.list_lines(prd, args.open)
    if args.cmd == "propose":
        touches = errors.parse_touches(args.touches)
        errors.propose(prd, args.eid, args.cls, args.diagnosis, args.recurrence, touches)
    elif args.cmd == "confirm":
        errors.confirm(prd, args.eid, args.reply, today, args.cls)
    elif args.cmd == "url":
        errors.set_url(prd, args.eid, args.address)
    elif args.red_run is not None:  # FR-080: red_run_refusals has passed
        errorreplay.write_red_run(prd, args.eid, args.commit, args.red_run, args.level)
    else:
        level = _level(prd, args.t) if args.t and not args.run and args.not_a_defect is None else None
        errors.resolve(prd, args.eid, t=args.t, level=level, version=args.version or "", commit=args.commit,
                       run=args.run, not_a_defect=args.not_a_defect)
    return [f"{args.eid} {errors.summary(model.load(prd.root).errors_ledger[args.eid])}"]


class LintRefused(deploy.Refused):
    """A write that would add a lint finding in errors.md."""


def _ledger_findings(root: Path) -> Counter:
    """Lint findings located in errors.md, keyed so a finding that only moved down a line still matches."""
    prd = model.load(root)
    lines = prd.docs.get("errors.md", "").split("\n")
    keys: Counter = Counter()
    for f in registry.run(prd):
        if f.file == "errors.md":
            text = lines[f.line - 1] if 0 < f.line <= len(lines) else ""
            keys[(f.line, f.rule, f.message, text)] += 1
    return keys


def _guarded_write(args: argparse.Namespace, prd: model.Prd, today: date) -> list[str]:
    """Run a ledger write; refuse it, leaving errors.md as it was, when it adds a lint finding there."""
    path = prd.root / "errors.md"
    original = path.read_bytes() if path.is_file() else None
    os.environ.setdefault("PRD_LINT_CI", "1")
    budget = Counter()
    for (_, rule, msg, text), n in _ledger_findings(prd.root).items():
        budget[(rule, msg, text)] += n
    out = _run(args, prd, today)
    try:
        added = []
        for (ln, rule, msg, text), n in sorted(_ledger_findings(prd.root).items()):
            for _ in range(n):
                if budget[(rule, msg, text)] > 0:
                    budget[(rule, msg, text)] -= 1
                else:
                    added.append((ln, rule, msg))
    except BaseException:
        _restore(path, original)
        raise
    if added:
        _restore(path, original)
        raise LintRefused([f"the entry would fail lint: errors.md:{ln}: {rule}: {msg}" for ln, rule, msg in added])
    return out


def _restore(path: Path, original: bytes | None) -> None:
    if original is None:
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(original)


def _glue_touches(argv: list[str]) -> list[str]:
    """`--touches -,FR-001` reads as an option to argparse; make it `--touches=-,FR-001`."""
    out: list[str] = []
    for i, a in enumerate(argv):
        if i and argv[i - 1] == "--touches" and a.startswith("-") and a != "-":
            out[-1] = f"--touches={a}"
        else:
            out.append(a)
    return out


RED_RUN_FLAGS = "--red-run takes --commit and --level, and no --t, --version, --run or --not-a-defect"


def _red_run_usage(args: argparse.Namespace) -> str | None:
    """AC-080.2 and AC-080.3: the flags `resolve --red-run` takes, and its commit's form."""
    if args.red_run is None and args.level is None:
        return None
    if args.red_run is None or args.level is None or args.commit is None \
            or any(v is not None for v in (args.t, args.version, args.run, args.not_a_defect)):
        return RED_RUN_FLAGS
    if not errors._COMMIT.fullmatch(args.commit):
        return f"commit must be 7 to 40 lowercase hex digits; got '{args.commit}'"
    return None


def _replay(argv: list[str]) -> int:
    """`replay` (FR-076 to FR-079): the proof, a skip or the findings; --json through prdlint/interface.py."""
    argv, asked = interface.split_argv(argv)
    try:
        args = _parser().parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    bad = interface.check_version(asked)
    if bad:
        print(f"prd_error: {bad}", file=sys.stderr)
        return 2
    if args.timeout is not None and not (re.fullmatch(r"[0-9]+", args.timeout) and int(args.timeout) >= 1):
        print("prd_error: --timeout must be a whole number of seconds of at least 1", file=sys.stderr)
        return 2
    signal.signal(signal.SIGINT, signal.default_int_handler)  # AC-079.4, even when started with SIGINT ignored
    try:
        prd = model.load(Path(args.prd_dir))
        rep = errorreplay.replay(prd, model.repo_root(prd.root), args.eid, int(args.timeout) if args.timeout else None)
    except KeyboardInterrupt:
        return 130
    except model.NotAPrd as e:
        print(f"prd_error: {e}", file=sys.stderr)
        return 2
    except deploy.Refused as e:
        for reason in e.reasons:
            print(f"refused: {reason}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"prd_error: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if args.json:
        sys.stdout.write(interface.dump(errorreplay.KIND, rep.payload()))
    else:
        for line in rep.lines():
            print(line)
    return 1 if rep.outcome == "findings" else 0


def main(argv: list[str], today: date | None = None) -> int:
    argv = _glue_touches(argv)
    if next((a for a in argv if not a.startswith("-")), None) == "replay":
        if "--interface" in argv:  # AC-078.13: whatever other arguments are given, no folder read
            print(interface.INTERFACE)
            return 0
        return interface.run(_replay, errorreplay.KIND, argv)
    try:
        args = _parser().parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if args.cmd == "resolve":
        usage = _red_run_usage(args)
        if usage:
            print(f"prd_error: {usage}", file=sys.stderr)
            return 2
    try:
        prd = model.load(Path(args.prd_dir))
        today = today or date.today()
        if args.cmd == "resolve" and args.red_run is not None:  # FR-080: refuse, or replay, before the guarded write
            signal.signal(signal.SIGINT, signal.default_int_handler)
            refusals = errorreplay.red_run_refusals(prd, model.repo_root(prd.root), args.eid, args.commit, args.red_run, args.level)
            if refusals:
                raise deploy.Refused(refusals)
        out = _run(args, prd, today) if args.cmd in ("check", "list") else _guarded_write(args, prd, today)
    except KeyboardInterrupt:
        if args.cmd == "resolve" and args.red_run is not None:  # FR-079: its replay's clones are gone
            return 130
        raise
    except (model.NotAPrd, ValueError, trace.BadRange) as e:
        print(f"prd_error: {e}", file=sys.stderr)
        return 2
    except deploy.Refused as e:
        for reason in e.reasons:
            print(f"refused: {reason}", file=sys.stderr)
        if isinstance(e, LintRefused):
            print("hint: put quoted output in backticks", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"prd_error: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    for line in out:
        print(line)
    return 1 if args.cmd == "check" and out else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
