#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Plan and run a PRD's deploy runbook. Exit 0 done, 1 refused, 2 usage or tool error, 3 human step, 4 failed.

`record` writes a deploy the owner did by hand: exit 0, 1 refused, 2 usage.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import deploy, model, trace  # noqa: E402


def _fail(message: str) -> int:
    print(f"prd_deploy: {message}", file=sys.stderr)
    return deploy.EXIT["usage"]


def _value_error(e: ValueError) -> int:
    """A corrupt run log is a tool error (the inbox answers 500); every other ValueError is a usage refusal."""
    if isinstance(e, deploy.CorruptLog):
        return _fail(f"internal error: {type(e).__name__}: {e}")
    return _fail(str(e))


TIMEOUT_HELP = "per command, overriding every level's Timeout (default: a tests level's Timeout, else 600)"


def _note_branch(prd: model.Prd, repo_root, run_id: str) -> None:
    """At a run's finish, one note line per other branch its environments deploy from (stderr only)."""
    try:
        notes = deploy.branch_note(prd, repo_root, deploy.reached_envs(deploy.read_log(repo_root, run_id)))
    except Exception:  # a note never changes the outcome
        return
    for note in notes:
        print(note, file=sys.stderr, flush=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="prd_deploy.py", description="Plan and run a PRD's deploy runbook.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in (("plan", "print the steps a run would take; runs nothing"), ("run", "pre-flight, then run the steps in order")):
        p = sub.add_parser(name, help=text)
        p.add_argument("prd_dir")
        p.add_argument("--until", metavar="ENV", help="stop after the last step on this environment")
        if name == "run":
            p.add_argument("--timeout", type=int, default=None, metavar="SECONDS", help=TIMEOUT_HELP)
    for name, text in (("resume", "continue a run after its confirmed human step"), ("confirm", "record the reply to the human step a run stopped at"),
                       ("rollback", "run a failed step's Rollback"),
                       ("recover", "turn a step killed before its result into a failed step")):
        p = sub.add_parser(name, help=text)
        p.add_argument("prd_dir")
        p.add_argument("--run", required=True, metavar="ID")
        many = "append" if name == "confirm" else "store"  # confirm takes the pair again for each consecutive human step
        if name != "resume":
            p.add_argument("--step", required=True, type=int, metavar="N", action=many)
        if name in ("confirm", "recover"):
            p.add_argument("--reply", required=True, metavar="TEXT", action=many, help="the user's words" if name == "recover" else None)
        else:
            p.add_argument("--timeout", type=int, default=None, metavar="SECONDS",
                           help=TIMEOUT_HELP if name == "resume" else "per command (default 600)")
    p = sub.add_parser("record", help="record a deploy the owner did by hand: a run log and the environment's Deployed row; runs nothing")
    p.add_argument("prd_dir")
    p.add_argument("--env", required=True, metavar="ENV")
    p.add_argument("--commit", required=True, metavar="SHA", help="the commit the owner deployed")
    p.add_argument("--reply", required=True, metavar="TEXT", help="the owner's words, verbatim")
    p = sub.add_parser("check", help="the close check: a deploy run's close commit says only what its log proves")
    p.add_argument("prd_dir")
    p.add_argument("--run", required=True, metavar="ID")
    p.add_argument("--diff", required=True, metavar="BASE..HEAD", help="BASE is the run's HEAD")
    return parser


def _steps_or_message(prd: model.Prd, until: str | None):
    """The planned steps, or an error string when the runbook cannot be run."""
    try:
        steps = deploy.plan_steps(prd, until)
    except ValueError as e:
        return None, str(e)
    if not steps:
        return None, "the PRD has no runbook steps"
    for s in steps:
        if s.actor not in ("agent", "human") or (s.actor == "agent" and s.run is None and s.tests is None):
            return None, f"step {s.number} does not match the runbook grammar; run prd_lint"
    return steps, None


def _run_and_report(prd: model.Prd, repo_root, run_id: str, steps, start: int, timeout: int | None) -> int:
    try:
        state, number = deploy.run_steps(prd, repo_root, run_id, steps, start, timeout)
    except Exception as e:  # the run has started: say so and fail it
        print(f"prd_deploy: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        state, number = "failed", 0
    print(f"prd-deploy: {state} step={number} run={run_id}")
    if state in ("done", "failed"):  # a run stopped at a human step has not finished
        _note_branch(prd, repo_root, run_id)
    return deploy.EXIT[state]


def _refuse(reasons: list[str], step: int, run_id: str) -> int:
    for r in reasons:
        print(f"refused: {r}")
    print(f"prd-deploy: refused step={step} run={run_id}")
    return deploy.EXIT["refused"]


def _existing_run(args, prd: model.Prd) -> int:
    """confirm, resume, rollback and recover: work on a run that has a log."""
    try:
        repo_root = model.repo_root(prd.root)
        if args.command == "confirm":
            if len(args.step) != len(args.reply):
                raise ValueError(f"{len(args.step)} --step but {len(args.reply)} --reply; give each step its own reply")
            deploy.confirm(prd, repo_root, args.run, list(zip(args.step, args.reply)))
            print(f"confirmed: step {', '.join(map(str, args.step))} run={args.run}")
            return 0
        deploy.check_run_id(args.run)
        if args.command == "recover":
            try:
                deploy.recover(prd, repo_root, args.run, args.step, args.reply)
            except deploy.Refused as e:
                return _refuse(e.reasons, args.step, args.run)
            print(f"recovered: step {args.step} run={args.run}")
            print(f"prd-deploy: failed step={args.step} run={args.run}")
            return deploy.EXIT["failed"]
        try:
            with deploy.repo_lock(repo_root):  # held through the final record; a second run, resume or rollback is refused
                return _rollback(args, prd, repo_root) if args.command == "rollback" else _resume(args, prd, repo_root)
        except deploy.Refused as e:
            return _refuse(e.reasons, args.step if args.command == "rollback" else 0, args.run)
    except ValueError as e:
        return _value_error(e)
    except Exception as e:
        return _fail(f"internal error: {type(e).__name__}: {e}")


def _rollback(args, prd: model.Prd, repo_root) -> int:
    try:
        code = deploy.rollback(prd, repo_root, args.run, args.step, args.timeout)
    except deploy.Refused as e:
        return _refuse(e.reasons, args.step, args.run)
    state = "rolled-back" if code == 0 else "rollback-failed"
    print(f"prd-deploy: {state} step={args.step} run={args.run}")
    return 0 if code == 0 else deploy.EXIT["failed"]


def _resume(args, prd: model.Prd, repo_root) -> int:
    """The checks come first, because the runbook is read from the PRD as it is now."""
    plan = {}

    def extra(confirmed: int, until) -> list[str]:
        steps, problem = _steps_or_message(prd, until)
        if problem:
            raise ValueError(problem)
        step = next((s for s in steps if s.number == confirmed), None)
        if step is None or step.actor != "human":
            return [f"step {confirmed} is not a human step of the runbook"]
        plan["steps"] = steps
        return []

    try:
        confirmed, until, reasons = deploy.start_resume(prd, repo_root, args.run, extra)  # records the resume before any command runs
    except deploy.Refused as e:
        return _refuse(e.reasons, 0, args.run)
    if reasons:
        return _refuse(reasons, confirmed, args.run)
    steps = plan["steps"]
    print(f"resume: {args.run}", flush=True)
    if confirmed == steps[-1].number:
        print(f"prd-deploy: done step={confirmed} run={args.run}")
        _note_branch(prd, repo_root, args.run)
        return deploy.EXIT["done"]
    return _run_and_report(prd, repo_root, args.run, steps, confirmed + 1, args.timeout)


def _new_run(args, prd: model.Prd, repo_root, steps) -> int:
    notes: list[str] = []
    reasons = deploy.preflight(prd, repo_root, args.until, notes=notes)
    if reasons:
        raise deploy.Refused(reasons)
    for note in notes:  # drift between members of an open change set, let through (R-13a)
        print(note, flush=True)
    run_id = deploy.new_run_id(repo_root, args.until)
    try:
        deploy.start_run(prd, repo_root, run_id, args.until)
    except Exception:
        (deploy.log_dir(repo_root) / f"{run_id}.jsonl").unlink(missing_ok=True)
        raise
    print(f"run: {run_id}", flush=True)
    return _run_and_report(prd, repo_root, run_id, steps, 1, args.timeout)


def main(argv: list[str]) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else deploy.EXIT["usage"]
    if args.command in ("run", "resume", "rollback") and args.timeout is not None and args.timeout < 1:
        return _fail("--timeout must be at least 1")
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        return _fail(str(e))
    except Exception as e:
        return _fail(f"internal error: {type(e).__name__}: {e}")
    if prd.adoption_unmigrated:
        return _fail(f"{prd.root.as_posix()}/prd.md: {model.UNMIGRATED}")
    if args.command in ("confirm", "resume", "rollback", "recover"):
        return _existing_run(args, prd)
    if args.command == "record":
        try:
            run_id = deploy.record(prd, model.repo_root(prd.root), args.env, args.commit, args.reply)
        except deploy.Refused as e:
            print(f"prd_deploy: {e.reasons[0]}", file=sys.stderr)
            return deploy.EXIT["refused"]
        except Exception as e:
            return _fail(f"internal error: {type(e).__name__}: {e}")
        print(f"run={run_id}")
        return 0
    if args.command == "check":
        try:
            found = deploy.close_findings(prd, model.repo_root(prd.root), args.run, args.diff)
        except deploy.CorruptLog as e:
            return _value_error(e)
        except (ValueError, trace.BadRange) as e:
            return _fail(str(e))
        except Exception as e:
            return _fail(f"internal error: {type(e).__name__}: {e}")
        for f in found:
            print(f)
        _note_branch(prd, model.repo_root(prd.root), args.run)
        return 1 if found else 0
    steps, problem = _steps_or_message(prd, args.until)
    if problem:
        return _fail(problem)
    try:
        if args.command == "plan":
            for s in steps:
                print(f"{s.number} {s.actor} {s.env}: {s.title}" + (f" — {deploy.step_command(s)}" if s.actor == "agent" else ""))
            return 0
        repo_root = model.repo_root(prd.root)
        try:
            with deploy.repo_lock(repo_root):  # pre-flight through the final record
                return _new_run(args, prd, repo_root, steps)
        except deploy.Refused as e:
            reasons = e.reasons
        for r in reasons:
            print(f"refused: {r}")
        print("prd-deploy: refused step=0 run=none")
        return deploy.EXIT["refused"]
    except Exception as e:
        return _fail(f"internal error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
