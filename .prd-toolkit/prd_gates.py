#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""The pending human decisions of a PRD (`list`), one reply for one of them (`answer`), a wait for its answer (`wait`) and the decision
inbox that answers them in the browser (`serve`). Exit 0 done, 1 refused, 3 wait timed out or serve stopped, 2 usage, dependency or internal error."""
import argparse
import errno
import signal
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import formserver, gates, interface, model  # noqa: E402


def _flags(parser: argparse.ArgumentParser, leaf: bool) -> None:
    """--json and --interface on the top parser and each leaf; a leaf that does not see them leaves the top value alone."""
    interface.add_flags(parser)
    if leaf:
        for a in parser._actions:
            if a.dest in ("json", "interface"):
                a.default = argparse.SUPPRESS


def _build() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prd_gates.py", description="The pending human decisions of a PRD.")
    _flags(parser, leaf=False)
    sub = parser.add_subparsers(dest="cmd")
    lst = sub.add_parser("list", help="print every pending gate")
    lst.add_argument("prd_dir")
    lst.add_argument("--worktrees", action="store_true", help="also list the approval gates of every worktree of the repository")
    _flags(lst, leaf=True)
    ans = sub.add_parser("answer", help="pass one reply for one gate to the script that owns the decision",
                         description="Re-lists the gate first; a gate that is gone or whose question changed is refused (exit 1). "
                                     "Free text goes to the owner as --opt=VALUE, so a reply may start with a dash.")
    ans.add_argument("prd_dir")
    ans.add_argument("gate", help="a gate id from `list`")
    ans.add_argument("--reply", required=True, help="the owner's words, verbatim (write --reply=TEXT when it starts with a dash)")
    ans.add_argument("--choice", help="one of the gate's choices (default: approve, confirm, confirm; a decision or done for adoption)")
    ans.add_argument("--class", dest="cls", help="error-class: the corrected class, with --choice correct")
    ans.add_argument("--result", help="signoff: the result, required; --choice, when given, must equal it")
    ans.add_argument("--item", help="adoption: the item the decision answers")
    ans.add_argument("--correction", help="adoption: the corrected text")
    ans.add_argument("--question", help="the question the client showed; a gate whose question differs is refused. Omitting it skips that check (only a gone gate is refused): clients should pass the question they showed")
    _flags(ans, leaf=True)
    wt = sub.add_parser("wait", help="block until the owner answers one gate, then print the outcome",
                        description="Start it before giving the owner the URL. Exit 0 answered, 1 the gate is not pending (choice null), 3 timed out.")
    wt.add_argument("prd_dir")
    wt.add_argument("gate")
    wt.add_argument("--worktree", help="the worktree whose gate it is (default: the PRD's own)")
    wt.add_argument("--timeout", type=float, help="seconds to wait (default: until answered)")
    _flags(wt, leaf=True)
    sv = sub.add_parser("serve", help="serve the decision inbox: every pending gate of the PRD across the worktrees",
                        description="Prints url=... first, then serves until Ctrl-C, SIGTERM or --idle-minutes without a request (exit 3). "
                                    "Exit 1 when --gate is not pending, or when an inbox for the PRD is already serving. With --gate it stands "
                                    "by behind that inbox instead and, if it stops before the gate is answered, takes over at the same URL; "
                                    "a standby exits 1 once its gate is no longer pending and 2 when it cannot take over the port.")
    sv.add_argument("prd_dir")
    sv.add_argument("--gate", help="open the page on this gate; refused when it is not pending")
    sv.add_argument("--port", type=int, help="bind this port (default: a free one)")
    sv.add_argument("--no-open", action="store_true", help="do not open the browser")
    sv.add_argument("--idle-minutes", type=float, default=120, help="stop after this long without a request (default 120)")
    return parser


def _cmd_answer(prd: model.Prd, args) -> tuple[str, dict]:
    done = gates.answer(prd, model.repo_root(prd.root), args.gate, args.reply, args.choice, args.cls, args.result, args.item, args.correction, args.question)
    return "", done


def _cmd_list(prd: model.Prd, args) -> tuple[str, dict]:
    found = gates.list_gates(prd, model.repo_root(prd.root), args.worktrees)
    return "".join(f"{g.id} {g.title}\n" for g in found), {"prd": prd.frontmatter.get("prd", prd.root.name), "gates": [g.to_dict() for g in found]}


def _cmd_wait(prd: model.Prd, args) -> tuple[str, dict]:
    code, outcome = gates.wait_gate(prd.root, args.gate, Path(args.worktree) if args.worktree else None, args.timeout)
    return str(code), outcome


def _stop(signum, frame) -> None:
    raise KeyboardInterrupt  # SIGTERM ends the inbox as Ctrl-C does: exit 3


# a `serve --gate` standing by behind a live inbox (spec section 18): it looks once every STANDBY_POLL seconds; once its gate
# is no longer pending it waits STANDBY_LINGER seconds (longer than `wait`'s GRACE, so `wait` reports first) and exits 1; when
# the bind of a takeover fails, a live inbox appearing within TAKEOVER_SETTLE seconds (most often another standby that bound
# the port first and is claiming the lock), or the URL it holds answering, is stood behind, and anything else is exit 2.
# A standby lives at most --idle-minutes, counted from when it began standing by, and then exits 3 as an idle inbox does.
STANDBY_POLL = 1.0
STANDBY_LINGER = 5.0
TAKEOVER_SETTLE = 3.0


def _serve(prd: model.Prd, args) -> int:
    if args.json:
        print("prd_gates: serve prints no JSON document", file=sys.stderr)
        return 2
    if args.gate and not any(g.id == args.gate for g in gates.list_gates(prd, model.repo_root(prd.root))):
        print(f"prd_gates: {args.gate} is not pending", file=sys.stderr)
        return 1
    main_thread = threading.current_thread() is threading.main_thread()  # a signal handler needs the main thread
    previous = signal.signal(signal.SIGTERM, _stop) if main_thread else None
    try:
        return _start(prd, args)
    except KeyboardInterrupt:  # Ctrl-C or SIGTERM before the server ran, or while standing by
        return 3
    finally:
        if main_thread:
            signal.signal(signal.SIGTERM, previous)


def _start(prd: model.Prd, args) -> int:
    try:
        server, token = gates.make_inbox(prd.root, port=args.port or 0, idle_minutes=args.idle_minutes)
    except gates.InboxLive as e:
        print(f"prd_gates: an inbox is already serving at {e.url}", file=sys.stderr, flush=True)
        return _standby(prd, args, e.record) if args.gate else 1
    except gates.Refused as e:
        print(f"prd_gates: {e}", file=sys.stderr)
        return 1
    except (OSError, formserver.PageError, gates.PrdUnreadable) as e:
        if isinstance(e, (formserver.PageError, gates.PrdUnreadable)) or not args.port:
            print(f"prd_gates: cannot start the inbox: {e}", file=sys.stderr)
        elif e.errno == errno.EADDRINUSE:
            print(f"prd_gates: port {args.port} is in use", file=sys.stderr)
        else:
            print(f"prd_gates: cannot bind port {args.port}: {e.strerror or e}", file=sys.stderr)
        return 2
    return _run_inbox(server, token, args, browser=not args.no_open)


def _run_inbox(server, token: str, args, browser: bool) -> int:
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/?token={token}" + (f"#gate={args.gate}" if args.gate else "")
        print(f"url={url}", flush=True)
        if browser:
            try:
                import webbrowser
                webbrowser.open(url)
            except Exception:
                pass
        return formserver.run(server)
    finally:
        server.server_close()


def _pending(prd: model.Prd, repo_root: Path, gate_id: str) -> bool:
    """The gate is in the listing the inbox shows, or an `answer` for it is still at work. A PRD that cannot be read
    this moment (a write in progress) counts as pending: the next look decides."""
    try:
        listed = any(g.id == gate_id for g in gates.list_gates(model.load(prd.root), repo_root, worktrees=True))
    except Exception:  # noqa: BLE001
        return True
    return listed or gates._answering(repo_root, gate_id)


def _standby(prd: model.Prd, args, record: dict | None) -> int:
    """Stand by behind the live inbox `record` names; take it over at its port, with its token, when it stops."""
    repo_root = model.repo_root(prd.root)
    slug = prd.frontmatter.get("prd", prd.root.name)
    until = time.monotonic() + args.idle_minutes * 60  # an orphaned standby's pings would keep a live inbox from idling out
    said: set[tuple[str, str]] = set()
    while True:
        time.sleep(STANDBY_POLL)
        if not _pending(prd, repo_root, args.gate):  # not pending wins over the idle bound in the same tick
            time.sleep(STANDBY_LINGER)
            print(f"prd_gates: {args.gate} is not pending", file=sys.stderr, flush=True)
            return 1
        if time.monotonic() >= until:
            return 3
        live = gates.live_inbox(repo_root, slug)
        if live or record is None:
            record = live or record
            continue
        try:
            model.load(prd.root)  # a PRD that cannot be read this moment is no port problem: look again next time
        except Exception:  # noqa: BLE001 - as _pending treats it
            continue
        try:
            server, token = gates.make_inbox(prd.root, port=record["port"], idle_minutes=args.idle_minutes, token=record["token"])
        except gates.InboxLive as e:  # another standby won the lock: stand behind that one
            record = e.record or record
            continue
        except gates.Refused as e:
            print(f"prd_gates: {e}", file=sys.stderr)
            return 1
        except formserver.PageError as e:
            print(f"prd_gates: cannot start the inbox: {e}", file=sys.stderr)
            return 2
        except (gates.PrdUnreadable, model.NotAPrd):  # the PRD vanished or changed since the look above: look again next time
            continue
        except OSError as e:
            other = _settled(repo_root, slug, record)
            if other:
                record = other
                continue
            print(f"prd_gates: cannot take over the inbox at port {record['port']}: {e.strerror or e}", file=sys.stderr, flush=True)
            return 2
        except Exception as e:  # noqa: BLE001 - keep standing by, but say a programming error once
            seen_key = (type(e).__name__, str(e))
            if seen_key not in said:
                said.add(seen_key)
                print(f"prd_gates: standby: {seen_key[0]}: {e}", file=sys.stderr, flush=True)
            continue
        return _run_inbox(server, token, args, browser=False)


def _settled(repo_root: Path, slug: str, record: dict) -> dict | None:
    """A live inbox within TAKEOVER_SETTLE seconds, or None: most often another standby that bound the port first. The URL
    `record` names answering /ping also counts (an inbox serves it, though a slow ping dropped its lock)."""
    end = time.monotonic() + TAKEOVER_SETTLE
    while True:
        live = gates.live_inbox(repo_root, slug)
        if live:
            return live
        if gates._ping(record["port"], record["token"]):
            return record
        if time.monotonic() >= end:
            return None
        time.sleep(0.1)


COMMANDS = {"list": ("gates", _cmd_list), "answer": ("gates.answer", _cmd_answer), "wait": ("gates.outcome", _cmd_wait)}


def main(argv: list[str]) -> int:
    """The error document's kind comes from the subcommand an argv pre-pass finds; `gates` when none parses."""
    return interface.run(_main, interface.subcommand_kind(argv, {cmd: kind for cmd, (kind, _h) in COMMANDS.items()}, "gates"), argv)


def _main(argv: list[str]) -> int:
    parser = _build()
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
        print(f"prd_gates: {bad}", file=sys.stderr)
        return 2
    entry = COMMANDS.get(args.cmd)
    if entry is None and args.cmd != "serve":
        parser.print_usage(sys.stderr)
        return 2
    kind, handler = entry or ("", None)
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd_gates: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_gates: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if args.cmd == "serve":
        try:
            return _serve(prd, args)
        except Exception as e:
            print(f"prd_gates: internal error: {type(e).__name__}: {e}", file=sys.stderr)
            return 2
    try:
        text, payload = handler(prd, args)
    except gates.Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"prd_gates: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if args.cmd == "wait":
        code = int(text)
        if code == 3:
            print(f"prd_gates: timed out waiting for {args.gate}", file=sys.stderr)
        else:
            sys.stdout.write(interface.dump(kind, payload))
        return code
    if args.cmd == "answer":
        owner = payload["result"]
        if args.json:
            sys.stdout.write(interface.dump(kind, payload))
        else:
            sys.stdout.write("".join(f"{ln}\n" for ln in owner["stdout"]))
            sys.stderr.write("".join(f"{ln}\n" for ln in owner.get("stderr", [])))
        return owner["exit"]
    sys.stdout.write(interface.dump(kind, payload) if args.json else text)
    return 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
