#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Confirm an adopted area: serve the form, print what is still open, or write the answers file from outside the form (answer, done, open).
Exit 0 Done, 2 usage or tool error, 3 stopped without Done; answer, done and open exit 0 on success, 1 refused (`refused: <why>` on stderr), 2 usage."""
import argparse
import errno
import signal
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import confirm, formserver, model  # noqa: E402


def _fail(message: str) -> int:
    print(f"prd_confirm: {message}", file=sys.stderr)
    return 2


def _status(prd, area: str) -> int:
    items = confirm.build_items(prd, area)
    answers = confirm.load_answers(confirm.answers_path(model.repo_root(prd.root), area))
    open_ids = confirm.open_ids(items, answers)
    print(f"{len(items) - len(open_ids)}/{len(items)}")
    for iid in open_ids:
        print(f"open {iid}")
    return 0


def _stop(signum, frame) -> None:
    raise KeyboardInterrupt  # SIGTERM ends the run as Ctrl-C does: stopped without Done, exit 3


def _serve(prd, args) -> int:
    confirm.ensure_excluded(model.repo_root(prd.root))  # first, so the summaries file never shows as untracked
    if threading.current_thread() is not threading.main_thread():  # a signal handler needs the main thread
        return _serve_items(prd, args)
    previous = signal.signal(signal.SIGTERM, _stop)
    try:
        return _serve_items(prd, args)
    finally:
        signal.signal(signal.SIGTERM, previous)


def _serve_items(prd, args) -> int:
    items = confirm.build_items(prd, args.area)
    if args.summaries:
        summaries = confirm.load_summaries(Path(args.summaries), items, args.area)
    else:  # the file `open` wrote carries them
        summaries = confirm.saved_summaries(items, args.area, model.repo_root(prd.root))
    try:
        page = formserver.assemble(confirm.page_path())
    except (OSError, formserver.PageError) as e:
        return _fail(f"cannot read the form page: {e}")
    try:
        server, token = confirm.make_server(prd, args.area, items, summaries, page, port=args.port or 0, idle_minutes=args.idle_minutes)
    except OSError as e:
        if not args.port:
            return _fail(f"cannot start the server: {e}")
        if e.errno == errno.EADDRINUSE:
            return _fail(f"port {args.port} is in use")
        return _fail(f"cannot bind port {args.port}: {e.strerror or e}")
    try:
        print(f"url=http://127.0.0.1:{server.server_address[1]}/?token={token}", flush=True)
        if not args.no_open:
            try:
                import webbrowser
                webbrowser.open(f"http://127.0.0.1:{server.server_address[1]}/?token={token}")
            except Exception:
                pass
        code = confirm.run(server)
        if server.end == "idle":
            _say_idle(args, items, model.repo_root(prd.root))
        return code
    finally:
        server.server_close()


def _say_idle(args, items, root: Path) -> None:
    try:
        left = len(confirm.open_ids(items, confirm.load_answers(confirm.answers_path(root, args.area))))
    except confirm.Refused:
        left = len(items)
    print(f"prd_confirm: stopped after {args.idle_minutes:g} minutes with no page open; {len(items) - left} of "
          f"{len(items)} answered, kept in {confirm.answers_path(root, args.area).name}; serve again to go on",
          file=sys.stderr)


def _write_command(prd, args) -> int:
    root = model.repo_root(prd.root)
    try:
        if args.command == "answer":
            confirm.record_answer(prd, args.area, args.item_id, args.decision, args.reply, args.correction, root)
            print(f"answered {args.item_id}")
        elif args.command == "done":
            confirm.mark_done(prd, args.area, confirm.build_items(prd, args.area), root)
            print(f"done {args.area}")
        else:
            items = confirm.build_items(prd, args.area)
            summaries = confirm.load_summaries(Path(args.summaries), items, args.area) if args.summaries else {}
            print(confirm.open_file(prd, args.area, items, summaries, root))
    except confirm.Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_confirm.py", description="Confirm an adopted area in the browser.")
    sub = parser.add_subparsers(dest="command")
    sv = sub.add_parser("serve", help="serve the form until Done")
    st = sub.add_parser("status", help="print answered/total and the open items")
    an = sub.add_parser("answer", help="answer one item without the form (exit 1 when refused, a corrupt answers file included)")
    dn = sub.add_parser("done", help="write done once no item is open (exit 1 when refused, a corrupt answers file included)")
    op = sub.add_parser("open", help="start the answers file with summaries and no answers")
    for p in (sv, st, op):
        p.add_argument("prd_dir")
        p.add_argument("--area", required=True)
    for p in (an, dn):
        p.add_argument("prd_dir")
        p.add_argument("area")
    an.add_argument("item_id")
    an.add_argument("--decision", required=True)
    an.add_argument("--reply", required=True, help="the owner's words, kept verbatim (write --reply=TEXT when it starts with a dash)")
    an.add_argument("--correction", help="the corrected text; the answer's text is this, else the reply")
    op.add_argument("--summaries", metavar="FILE", help="JSON mapping item ID to a one or two sentence summary")
    sv.add_argument("--summaries", metavar="FILE", help="JSON mapping item ID to a one or two sentence summary")
    sv.add_argument("--port", type=int, help="bind this port (default: a free one)")
    sv.add_argument("--no-open", action="store_true", help="do not open the browser")
    sv.add_argument("--idle-minutes", type=float, default=120, help="stop after this long without a request (default 120)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if not args.command:
        parser.print_usage(sys.stderr)
        return 2
    try:
        prd = model.load(Path(args.prd_dir))
        if args.command in ("answer", "done", "open"):
            return _write_command(prd, args)
        return _serve(prd, args) if args.command == "serve" else _status(prd, args.area)
    except (model.NotAPrd, confirm.Refused) as e:
        return _fail(str(e))
    except KeyboardInterrupt:  # Ctrl-C or SIGTERM before the server ran (say, while the browser opened)
        return 3
    except Exception as e:
        return _fail(f"internal error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
