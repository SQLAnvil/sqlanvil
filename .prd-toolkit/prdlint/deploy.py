"""prd_deploy's engine: plan the runbook, check pre-flight, run steps, keep the log.

The only code that runs a runbook's commands. Commands run with `bash -c` at the repo root with
stdin closed, in their own process group so a timeout kills the whole tree.
"""
import difflib
import hashlib
import json
import os
import re
import signal
import sys
import subprocess
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None
    import msvcrt

from . import registry, trace
from .buildcheck import _resolve, _show
from .markdown import frontmatter, sections
from .model import Prd, Step, _errors_ledger, gate_of, load, production_envs
from .trace import BadRange

EXIT = {"done": 0, "refused": 1, "usage": 2, "human": 3, "failed": 4}
TAIL = 4096
DEFAULT_TIMEOUT = 600


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _git(repo_root: Path, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=repo_root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {(proc.stderr.strip().splitlines() or ['no output'])[0]}")
    return proc.stdout


def step_command(step: Step) -> str:
    """What `plan` shows for an agent step: its command, or `tests <levels>`."""
    return step.run if step.run is not None else "tests " + ", ".join(step.tests or [])


def plan_steps(prd: Prd, until: str | None) -> list[Step]:
    """The steps a run takes: all of them, or through the last step on `until`."""
    steps = list(prd.operations.steps)
    if until is None:
        return steps
    ends = [i for i, s in enumerate(steps) if s.env == until]
    if not ends:
        envs = list(dict.fromkeys(s.env for s in steps if s.env))
        raise ValueError(f"no step runs on {until}; environments with steps: {', '.join(envs) or 'none'}")
    cut = steps[: ends[-1] + 1]
    prod = production_envs(prd)
    if until not in prod:
        first = next((s for s in cut if s.env in prod), None)
        if first is not None:  # a staging step after production would carry production along
            raise ValueError(f"--until {until} would include production step {first.number}")
    return cut


def preflight(prd: Prd, repo_root: Path, until: str | None = None, notes: list[str] | None = None) -> list[str]:
    """Reasons a run must not start; empty when clear. Drift between members of an open change set (R-13a) is no
    reason: each such check line goes to `notes` as `drift allowed by <start-prd>/CS-nnn: <line>`."""
    reasons: list[str] = []
    if _git(repo_root, "status", "--porcelain", "--untracked-files=no").strip():
        reasons.append("the tracked tree has changes")
    if registry.run(prd):
        reasons.append("prd_lint has findings")
    if trace.run_trace(prd, repo_root, None):
        reasons.append("prd_trace has findings")
    for b in prd.blocks:
        if b.status == "built":
            reasons.append(f"{b.id} is built; its tests have not passed (run /prd-toolkit:prd-build)")
    if prd.links is not None:
        from . import links  # lazy: links imports git machinery a plain deploy does not need
        lines = links.check(prd)
        if links.check_exit(lines) == 1:  # exit 3 (unreachable only) adds nothing; the run's report prints that line
            kept = []
            for x, by in links.let_through(prd, repo_root, lines):
                if by is not None:
                    if notes is not None:
                        notes.append(links.allowed(by, x))
                elif links.is_drift(x):
                    kept.append(x)
            drift = [f"{x.name} {x.item}" if x.item else f"{x.side} {x.name}" for x in kept]
            if drift:
                reasons.append("prd_links check found drift: " + ", ".join(dict.fromkeys(drift)))
    if any(s.env in production_envs(prd) for s in plan_steps(prd, until)):
        # trace lets a verified block lack deploy-gate citations, but `live` needs every one: such a run cannot close
        cited = trace.citations(prd, repo_root)
        for b in prd.blocks:
            if b.status != "verified":
                continue
            for tid, level, _ in b.tests:
                if tid not in cited and gate_of(prd, level) == "deploy":
                    reasons.append(f"{b.id}: {tid} (deploy gate) has no citing test; it cannot go live")
    return reasons


def log_dir(repo_root: Path) -> Path:
    common = Path(_git(repo_root, "rev-parse", "--git-common-dir").strip())
    if not common.is_absolute():
        common = repo_root / common
    return common.resolve() / "prd-toolkit" / "deploys"


def new_run_id(repo_root: Path, until: str | None) -> str:
    base = f"{_now().astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{until or 'all'}"
    taken = log_dir(repo_root)
    taken.mkdir(parents=True, exist_ok=True)
    run_id, n = base, 1
    while True:
        try:
            with open(taken / f"{run_id}.jsonl", "x", encoding="utf-8"):
                return run_id  # the empty log reserves the id
        except FileExistsError:
            n += 1
            run_id = f"{base}-{n}"


def _log_path(repo_root: Path, run_id: str) -> Path:
    return log_dir(repo_root) / f"{run_id}.jsonl"


def append(repo_root: Path, run_id: str, record: dict) -> None:
    path = _log_path(repo_root, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def prd_rel(prd: Prd, repo_root: Path) -> str:
    """The PRD folder relative to the repo root, as the log header records it."""
    return Path(os.path.relpath(prd.root.resolve(), repo_root.resolve())).as_posix()


def runbook_hash(prd_root: Path) -> str:
    """sha256 of the PRD folder's operations.md and testing.md as they are on disk: what a run reads its commands from."""
    h = hashlib.sha256()
    for name in ("operations.md", "testing.md"):
        try:
            data = (Path(prd_root) / name).read_bytes()
        except FileNotFoundError:
            data = b""
        h.update(name.encode() + b"\0" + str(len(data)).encode() + b"\0" + data)
    return h.hexdigest()


def start_run(prd: Prd, repo_root: Path, run_id: str, until: str | None) -> None:
    """Write the log header: the commit, PRD folder, PRD version and runbook the run is for."""
    append(repo_root, run_id, {
        "kind": "header", "run": run_id, "head": _git(repo_root, "rev-parse", "HEAD").strip(),
        "prd": prd_rel(prd, repo_root), "runbook": runbook_hash(prd.root),
        "version": prd.frontmatter.get("version"), "until": until, "started": _iso(),
    })


def read_log(repo_root: Path, run_id: str) -> list[dict]:
    text = _log_path(repo_root, run_id).read_text(encoding="utf-8")
    # split on "\n" only: splitlines() also splits on \x1c-\x1e, \x85, U+2028/9, which a raw tail may hold
    return [json.loads(line) for line in text.split("\n") if line.strip()]


def _iso() -> str:
    return _now().astimezone(timezone.utc).isoformat()


def _tail(data: bytes) -> str:
    return data[-TAIL:].decode("utf-8", errors="replace")


def command_timeout(given: int | None) -> tuple[int, str]:
    """A `Run:`, `Check:` or `Rollback:` command's seconds and the timeout message's parenthesis."""
    return (given, "--timeout") if given is not None else (DEFAULT_TIMEOUT, "the default")


def level_timeout(prd: Prd, level: str, given: int | None) -> tuple[int, str]:
    """A tests level's seconds and the message's parenthesis: a given --timeout, else the level's Timeout, else the default."""
    cell = prd.testing.timeouts.get(level, "")
    if given is None and cell:
        return int(cell), f"the {level} level's Timeout"
    return command_timeout(given)


def _execute(cmd: str, repo_root: Path, extra_env: dict[str, str], timeout: int, why: str | None = None) -> dict:
    """Run `cmd`; returns exit, full stdout bytes, stderr tail text and whether it timed out. `why`, when given, names
    where the timeout came from in the timeout message."""
    proc = subprocess.Popen(
        ["bash", "-c", cmd], cwd=repo_root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**{k: v for k, v in os.environ.items() if k != "TEST_ENV"}, **extra_env}, start_new_session=True,
    )
    timed_out = False
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            out, err = b"", b""
    stderr = _tail(err)
    if timed_out:
        stderr += ("" if not stderr or stderr.endswith("\n") else "\n") + f"timed out after {timeout} s" + (f" ({why})" if why else "")
    return {"exit": proc.returncode, "out": out, "stdout": _tail(out), "stderr": stderr, "timed_out": timed_out}


def _prints_ok(out: bytes, text: str) -> bool:
    want = text.strip()
    return any(line.strip() == want for line in out.decode("utf-8", errors="replace").splitlines())


def _matches_ok(out: bytes, pattern: str) -> bool:
    """At least one stdout line, stripped, satisfies re.fullmatch(pattern, line)."""
    return any(re.fullmatch(pattern, line.strip()) for line in out.decode("utf-8", errors="replace").splitlines())


def _agent_record(step: Step, repo_root: Path, timeout: int | None, mark) -> dict:
    env = {"PRD_ENV": step.env or ""}
    rec = {"command": step.run, "started": _iso()}
    mark(command=step.run)  # written before the command starts; if it fails the command does not run
    first = _execute(step.run, repo_root, env, *command_timeout(timeout))
    rec.update(exit=first["exit"], stdout=first["stdout"], stderr=first["stderr"])
    ok = first["exit"] == 0 and not first["timed_out"]
    if ok and step.check is not None:
        mark(command=step.check, check=True)
        c = _execute(step.check, repo_root, env, *command_timeout(timeout))
        rec["check"] = {"command": step.check, "exit": c["exit"], "stdout": c["stdout"], "stderr": c["stderr"]}
        ran = c["exit"] == 0 and not c["timed_out"]
        if ran and step.prints is not None and not _prints_ok(c["out"], step.prints):
            ok, why = False, f"no stdout line equals {step.prints!r}"
        elif ran and step.matches is not None and not _matches_ok(c["out"], step.matches):
            ok, why = False, f"no stdout line matches '{step.matches}'"
        else:
            ok, why = ran, None
        if why:
            rec["check"]["stderr"] = (c["stderr"] + "\n" + why).lstrip("\n")
    rec["result"] = "pass" if ok else "fail"
    rec["ended"] = _iso()
    return rec


def _tests_records(prd: Prd, step: Step, repo_root: Path, timeout: int | None, mark) -> list[dict]:
    """One record per level, each with its own timeout (level_timeout), stopping at the first failure."""
    recs = []
    if not step.tests:
        now = _iso()
        return [{"command": None, "exit": None, "stdout": "", "stderr": "tests step names no levels", "started": now, "ended": now, "result": "fail"}]
    for level in step.tests:
        command = prd.testing.commands.get(level)
        rec = {"level": level, "command": command, "started": _iso()}
        if not command:
            rec.update(exit=None, stdout="", stderr=f"no Harness command for level {level}", result="fail")
        else:
            mark(level=level, command=command)
            r = _execute(command, repo_root, {"PRD_ENV": step.env or "", "TEST_ENV": step.env or ""}, *level_timeout(prd, level, timeout))
            rec.update(exit=r["exit"], stdout=r["stdout"], stderr=r["stderr"], result="pass" if r["exit"] == 0 and not r["timed_out"] else "fail")
        rec["ended"] = _iso()
        recs.append(rec)
        if rec["result"] == "fail":
            break
    return recs


def run_steps(prd: Prd, repo_root: Path, run_id: str, steps: list[Step], start: int, timeout: int | None) -> tuple[str, int]:
    """Run `steps` numbered `start` onward, logging and printing each. Returns (state, step number reached).

    `timeout` is the --timeout given, or None: then each tests level takes its Timeout and every command the default."""
    reached = start
    for step in steps:
        if step.number < start:
            continue
        reached = step.number
        base = {"kind": "step", "step": step.number, "env": step.env, "actor": step.actor}
        if step.actor == "human":
            now = _iso()
            if any(r.get("kind") == "confirm" and r.get("step") == step.number and r.get("ahead") for r in read_log(repo_root, run_id)):
                append(repo_root, run_id, {**base, "command": None, "exit": None, "stdout": "", "stderr": "", "started": now, "ended": now,
                                           "result": "human", "confirmed_ahead": True})  # the owner answered this step in the stopped step's confirm
                print(f"step {step.number} human {step.env}: confirmed ahead", flush=True)
                continue
            append(repo_root, run_id, {**base, "command": None, "exit": None, "stdout": "", "stderr": "", "started": now, "ended": now, "result": "human"})
            print(f"step {step.number} human {step.env}: human", flush=True)
            return "human", step.number
        def mark(**extra):
            append(repo_root, run_id, {"kind": "start", "step": step.number, "env": step.env, **extra, "at": _iso()})

        try:
            recs = _tests_records(prd, step, repo_root, timeout, mark) if step.tests is not None else [_agent_record(step, repo_root, timeout, mark)]
        except Exception as e:  # a command could not even start: record it as a failed step
            now = _iso()
            recs = [{"command": step_command(step), "exit": None, "stdout": "", "stderr": f"{type(e).__name__}: {e}", "started": now, "ended": now, "result": "fail"}]
        try:
            for rec in recs:
                append(repo_root, run_id, {**base, **rec})
        except Exception as e:
            print(f"prd_deploy: could not write the log: {e}", file=sys.stderr)
            recs = [{"result": "fail"}]
        passed = bool(recs) and all(r["result"] == "pass" for r in recs)
        print(f"step {step.number} {step.actor} {step.env}: {'pass' if passed else 'fail'}", flush=True)
        if not passed:
            if step.rollback:
                print(f"rollback: `{step.rollback}`", flush=True)
            return "failed", step.number
    return "done", reached


class Refused(Exception):
    """A resume or rollback condition failed; `reasons` are printed one per `refused:` line."""

    def __init__(self, reasons: list[str]):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


def check_run_id(run_id: str) -> str:
    """A run id names a log file under the deploys folder, so it may not name a path."""
    if not RUN_ID.fullmatch(run_id):
        raise ValueError(f"not a run id: {run_id!r}")
    return run_id


RUN_ID = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]*")


class CorruptLog(ValueError):
    """The run's log exists but cannot be read or has no header: a tool error, not the caller's refusal."""


def _load_log(repo_root: Path, run_id: str) -> tuple[dict, list[dict]]:
    """The header and the records after it; ValueError when the run has no usable log."""
    check_run_id(run_id)
    try:
        recs = read_log(repo_root, run_id)
    except FileNotFoundError:
        raise ValueError(f"no log for run {run_id}") from None
    except (ValueError, OSError) as e:
        raise CorruptLog(f"cannot read the log of run {run_id}: {e}") from None
    if not recs or recs[0].get("kind") != "header":
        raise CorruptLog(f"the log of run {run_id} has no header")
    return recs[0], recs[1:]


def _last_step(recs: list[dict]) -> dict | None:
    steps = [r for r in recs if r.get("kind") == "step"]
    return steps[-1] if steps else None


def _confirmed(recs: list[dict], step: int) -> bool:
    return any(r.get("kind") == "confirm" and r.get("step") == step for r in recs)


def other_prd(prd: Prd, repo_root: Path, run_id: str, header: dict) -> str | None:
    """Why the run is not this PRD's, or None when it is. A log with no PRD folder predates the field and is never trusted."""
    recorded = header.get("prd")
    if not isinstance(recorded, str) or not recorded:
        return f"run {run_id}'s log names no PRD folder; start a new run"
    here = prd_rel(prd, repo_root)
    return None if recorded == here else f"run {run_id} is for {recorded}, not {here}"


def confirm(prd: Prd, repo_root: Path, run_id: str, pairs: list[tuple[int, str]]) -> None:
    """Record the replies to the human step the run stopped at (the first pair) and to the human steps right after it.

    All pairs are checked before any is written, under the run lock. ValueError (a usage error) when one cannot be."""
    if not pairs:
        raise ValueError("no step and reply given")
    step, reply = pairs[0]
    try:
        with run_lock(repo_root, run_id):
            header, recs = _load_log(repo_root, run_id)
            wrong = other_prd(prd, repo_root, run_id, header)
            if wrong:
                raise ValueError(wrong)
            last = _last_step(recs)
            if last is None or last.get("step") != step or last.get("result") != "human":
                raise ValueError(f"step {step} is not the human step this run stopped at")
            if not reply.strip():
                raise ValueError("the reply is empty")
            if _confirmed(recs, step):
                raise ValueError(f"step {step} already has a confirm record")
            if len(pairs) > 1:
                planned = {s.number: s for s in plan_steps(prd, header.get("until"))}
                for (before, _), (n, text) in zip(pairs, pairs[1:]):
                    if n != before + 1:
                        raise ValueError(f"step {n} does not follow step {before}; a confirm covers consecutive steps")
                    if n not in planned:
                        raise ValueError(f"step {n} is not a step of this run (past --until or the runbook's end)")
                    if planned[n].actor != "human":
                        raise ValueError(f"step {n} is not a human step")
                    if not text.strip():
                        raise ValueError(f"the reply for step {n} is empty")
            for n, text in pairs:
                rec = {"kind": "confirm", "step": n, "reply": text, "at": _iso()}
                append(repo_root, run_id, rec if n == step else {**rec, "ahead": True})
    except Refused as e:
        raise ValueError(e.reasons[0]) from None


def run_entries_only(prd: Prd, repo_root: Path, header: dict, run_id: str) -> bool:
    """True when the tracked tree's only change is errors.md gaining entries, each open, unclassified and with a
    `Detected:` line naming this run and a step; the old text must be exactly as it was at the run's head."""
    lines = _git(repo_root, "status", "--porcelain", "--untracked-files=no").splitlines()
    rel = f"{prd_rel(prd, repo_root)}/errors.md".removeprefix("./")
    if [ln[3:] for ln in lines] != [rel] or not all(ln[:2].strip() == "M" for ln in lines):
        return False
    path = repo_root / rel
    if not path.is_file():
        return False
    base, now = _show(repo_root, str(header.get("head")), rel), path.read_text(encoding="utf-8")
    base_ids, new = set(_errors_ledger(base)), _errors_ledger(now)
    added = [e for i, e in new.items() if i not in base_ids]
    if not added:
        return False  # only added entries pass; any other change is refused
    now_lines = now.split("\n")
    for e in added:
        detected = re.search(r"^Detected:.*$", "\n".join(now_lines[e.line - 1:e.end]), re.M)
        if not (e.open and e.classification == "unclassified" and detected_names_failure(detected.group(0) if detected else None, run_id, None)):
            return False
    gone = {n for e in added for n in range(e.line, e.end + 1)}
    kept = [t for n, t in enumerate(now_lines, 1) if n not in gone]
    old = base.split("\n")
    if not base_ids:
        old = [t for t in old if t.strip() != LEDGER_PLACEHOLDER]
    return "\n".join(kept).rstrip() == "\n".join(old).rstrip()


def _moved(prd: Prd, repo_root: Path, header: dict) -> list[str]:
    """Why the run no longer matches the repo; empty when it still does. Check this before reading the runbook."""
    reasons = []
    if _git(repo_root, "rev-parse", "HEAD").strip() != header.get("head"):
        reasons.append("HEAD moved since the run started")
    if prd.frontmatter.get("version") != header.get("version"):
        reasons.append("the PRD version changed since the run started")
    if _git(repo_root, "status", "--porcelain", "--untracked-files=no").strip() and not run_entries_only(prd, repo_root, header, str(header.get("run"))):
        reasons.append("the tracked tree has changes")  # the runbook is read from the working tree
    if runbook_hash(prd.root) != header.get("runbook"):
        reasons.append("the runbook changed since the run started")  # an untracked or assume-unchanged PRD moves no HEAD
    return reasons


def _used_or_unfinished(recs: list[dict]) -> list[str]:
    """A confirm is used once, and a command that was started is never run again."""
    reasons = []
    last = _last_step(recs)
    if last is not None and last.get("result") == "human":  # only the human step the run stopped at
        n = last["step"]
        idx = [i for i, r in enumerate(recs) if r.get("kind") == "confirm" and r.get("step") == n]
        if idx and any(r.get("kind") == "resume" and r.get("step") == n for r in recs[idx[-1] + 1:]):
            reasons.append(f"step {n}'s confirm was already used")
    unfinished = unfinished_starts(recs)
    if unfinished:
        reasons.append(f"step {unfinished[0].get('step')} started and did not finish; check the environment, then start a new run")
    return list(dict.fromkeys(reasons))


def unfinished_starts(recs: list[dict]) -> list[dict]:
    """The step `start` records (not rollback ones) that no later record of the same step and level completes."""
    out = []
    for i, r in enumerate(recs):
        if r.get("kind") != "start" or r.get("rollback"):
            continue
        done = any(x.get("kind") == "step" and x.get("step") == r.get("step") and (r.get("level") is None or x.get("level") in (None, r.get("level")))
                   for x in recs[i + 1:])
        if not done:
            out.append(r)
    return out


@contextmanager
def run_lock(repo_root: Path, run_id: str):
    """An exclusive, non-waiting lock on the run's log, so two commands cannot both pass their checks before either records.

    Raises Refused when another prd_deploy holds it. Never hold it while a runbook command runs.
    """
    check_run_id(run_id)
    try:
        f = open(_log_path(repo_root, run_id), "r+", encoding="utf-8")  # never creates a log for an unknown run
    except FileNotFoundError:
        raise ValueError(f"no log for run {run_id}") from None
    try:
        try:
            if fcntl is not None:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise Refused(["another prd_deploy command is working on this run"]) from None
        yield
    finally:
        f.close()  # closing releases the lock


@contextmanager
def repo_lock(repo_root: Path):
    """An exclusive, non-waiting lock on `<log dir>/.active`, held while run, resume or rollback executes commands.

    Raises Refused when another prd_deploy holds it. A run stopped at a human step has exited, so it holds none.
    """
    path = log_dir(repo_root) / ".active"
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+", encoding="utf-8")
    try:
        try:
            if fcntl is not None:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise Refused(["another prd_deploy command is running in this repository"]) from None
        yield
    finally:
        f.close()  # closing releases the lock


def recover(prd: Prd, repo_root: Path, run_id: str, step: int, reply: str) -> None:
    """Turn a step killed between its `start` and its result into an ordinary failed step, on the user's word that they checked.

    Never records a pass. ValueError (a usage error) for no usable log or an empty reply; Refused for another PRD's run, a held lock,
    or a step with no unfinished start. Takes the repository lock, then the run lock, as `run` does.
    """
    check_run_id(run_id)
    with repo_lock(repo_root), run_lock(repo_root, run_id):
        header, recs = _load_log(repo_root, run_id)
        wrong = other_prd(prd, repo_root, run_id, header)
        if wrong:
            raise Refused([wrong])
        if not reply.strip():
            raise ValueError("the reply is empty")
        starts = [r for r in unfinished_starts(recs) if r.get("step") == step]
        if not starts:
            if any(r.get("kind") == "step" and r.get("step") == step for r in recs):
                raise Refused([f"step {step} already has a result in run {run_id}"])
            raise Refused([f"step {step} has no unfinished start in run {run_id}"])
        start = starts[-1]
        now = _iso()
        append(repo_root, run_id, {"kind": "recover", "step": step, "reply": reply, "at": now})
        rec = {"kind": "step", "step": step, "env": start.get("env"), "result": "fail", "reason": "recovered: no result after start",
               "started": start.get("at"), "ended": now}
        if start.get("level") is not None:
            rec["level"] = start["level"]
        append(repo_root, run_id, rec)


def start_resume(prd: Prd, repo_root: Path, run_id: str, extra=None) -> tuple[int, str | None, list[str]]:
    """Check that the run may continue and, under the run lock, use up the confirm in the same breath.

    Returns (confirmed step, until, reasons); the resume record is written only when `reasons` is empty.
    `extra(confirmed, until)` may add reasons (or raise ValueError) before anything is recorded.
    """
    with run_lock(repo_root, run_id):
        confirmed, until = resume_point(repo_root, run_id)
        reasons = resume_problems(prd, repo_root, run_id)
        if not reasons and extra is not None:
            reasons = extra(confirmed, until)
        if not reasons:
            append(repo_root, run_id, {"kind": "resume", "step": confirmed, "at": _iso()})
        return confirmed, until, reasons


def resume_problems(prd: Prd, repo_root: Path, run_id: str) -> list[str]:
    """Reasons the run may not continue; empty when it may. ValueError when the run has no usable log."""
    header, recs = _load_log(repo_root, run_id)
    wrong = other_prd(prd, repo_root, run_id, header)
    if wrong:
        return [wrong]  # another PRD's run: nothing else about it applies here
    reasons = _moved(prd, repo_root, header)
    reasons += _used_or_unfinished(recs)
    failed = next((r for r in recs if r.get("kind") == "step" and r.get("result") == "fail"), None)
    last = _last_step(recs)
    if failed is not None:
        reasons.append(f"step {failed['step']} failed; a failed run ends (start a new run)")
    elif last is None:
        reasons.append("the run has no step records")
    elif last.get("result") == "human" and not last.get("confirmed_ahead"):  # an ahead-confirmed step is answered, not a stop
        if not _confirmed(recs, last["step"]):
            reasons.append(f"step {last['step']} has no confirm record")
    else:
        try:
            final = plan_steps(prd, header.get("until"))[-1].number
        except (ValueError, IndexError):
            final = None
        reasons.append("the run is done" if last["step"] == final else f"the run did not stop at a human step (last step {last['step']})")
    return reasons


def resume_point(repo_root: Path, run_id: str) -> tuple[int, str | None]:
    """The confirmed human step to continue after, and the run's `until`."""
    header, recs = _load_log(repo_root, run_id)
    last = _last_step(recs)
    return (last["step"] if last else 0), header.get("until")


def rollback(prd: Prd, repo_root: Path, run_id: str, step: int, timeout: int | None) -> int:
    """Run failed step `step`'s Rollback once and log it; returns the command's exit code (-1 when it never ran to an exit).

    ValueError for a usage problem, Refused when the run is another PRD's, or HEAD, the PRD version, the tree or the runbook moved.
    """
    with run_lock(repo_root, run_id):
        header, recs = _load_log(repo_root, run_id)
        wrong = other_prd(prd, repo_root, run_id, header)
        if wrong:
            raise Refused([wrong])
        last = _last_step(recs)
        if last is None or last.get("step") != step or last.get("result") != "fail":
            raise ValueError(f"step {step} is not the failed step of this run")
        reasons = _moved(prd, repo_root, header)
        if reasons:
            raise Refused(reasons)
        target = next((s for s in prd.operations.steps if s.number == step), None)
        if target is None or not target.rollback:
            raise ValueError(f"step {step} has no Rollback")
        if any(r.get("kind") == "start" and r.get("rollback") and r.get("step") == step for r in recs):
            raise ValueError(f"step {step}'s rollback was already started")
        if any(r.get("kind") == "rollback" and r.get("step") == step for r in recs):
            raise ValueError(f"step {step} was already rolled back")
        started = _iso()
        try:
            append(repo_root, run_id, {"kind": "start", "step": step, "env": target.env, "rollback": True, "command": target.rollback, "at": started})
        except Exception as e:
            raise ValueError(f"could not record the rollback start, so it was not run: {e}") from None
    try:
        r = _execute(target.rollback, repo_root, {"PRD_ENV": target.env or ""}, *command_timeout(timeout))
        rec = {"exit": r["exit"], "stdout": r["stdout"], "stderr": r["stderr"], "ok": r["exit"] == 0 and not r["timed_out"]}
    except Exception as e:  # the command could not even start
        rec = {"exit": None, "stdout": "", "stderr": f"{type(e).__name__}: {e}", "ok": False}
    ok = rec.pop("ok")
    append(repo_root, run_id, {"kind": "rollback", "step": step, "command": target.rollback, **rec, "started": started, "ended": _iso()})
    print(f"rollback step {step} {target.env}: {'pass' if ok else 'fail'}", flush=True)
    return 0 if ok else (rec["exit"] if rec["exit"] not in (None, 0) else -1)


# ---- the close on another branch (0.8.5 spec 5.4) ----

def reached_envs(log: list[dict]) -> list[str]:
    """The environments a run's log has step (or by-hand) records for, in order, each once."""
    return list(dict.fromkeys(r["env"] for r in log if r.get("kind") in ("step", "hand") and r.get("env")))


def branch_note(prd: Prd, repo_root: Path, envs: list[str]) -> list[str]:
    """One note line per branch, other than the current one, that one of `envs` deploys from (its Branch cell), each
    once, in the order the environments were reached; empty when there is none. A note, never a refusal or a finding."""
    current = _git(repo_root, "branch", "--show-current").strip()
    other = dict.fromkeys(b for b in (prd.operations.branches.get(e, "") for e in envs) if b and b != current)
    here = current or "a detached HEAD"
    return [f"prd_deploy: the close is on {here}, not {b}; push the close commit to {b} too" for b in other]


# ---- a deploy done by hand (spec section 17, fix 5) ----

def write_deployed_row(prd: Prd, env: str, version: str, commit7: str, date: str, run_id: str) -> None:
    """Replace `env`'s Deployed row in operations.md, or add it; creates `## Deployed` at the file's end when missing."""
    path = prd.root / "operations.md"
    text = path.read_text(encoding="utf-8")
    row = f"| {env} | {version} | {commit7} | {date} | {run_id} |"
    lines = text.split("\n")
    s = _deployed_section(text)
    if s is None:
        body = text.rstrip("\n")
        path.write_text(f"{body}\n\n## Deployed\n\n| {' | '.join(_HEADER)} |\n|---|---|---|---|---|\n{row}\n", encoding="utf-8")
        return
    mine = [r.line for r in prd.operations.deployed if r.env == env]
    if mine:
        lines[mine[0] - 1] = row
        for n in sorted(mine[1:], reverse=True):  # one row per environment
            del lines[n - 1]
    else:
        table = [n for n, t in s.body if t.strip().startswith("|")]
        if table:
            lines.insert(table[-1], row)  # after the table's last line
        else:
            lines.insert(s.line, f"\n| {' | '.join(_HEADER)} |\n|---|---|---|---|---|\n{row}")
    path.write_text("\n".join(lines), encoding="utf-8")


def record(prd: Prd, repo_root: Path, env: str, commit: str, reply: str) -> str:
    """Record a deploy the owner did by hand: a `by: hand` run log and `env`'s Deployed row, left uncommitted.

    Runs nothing and moves no status. Returns the run id; Refused for an environment not in both Environments tables,
    a commit not in the repository, an empty reply, a commit whose prd.md has no version, or a held repository lock,
    with nothing written. Takes the repository lock after those checks, as `recover` does.
    """
    if env not in prd.operations.environments or env not in prd.testing.environments:
        raise Refused([f"environment {env} is not in both Environments tables"])
    p = subprocess.run(["git", "rev-parse", "--verify", "--quiet", "--end-of-options", f"{commit}^{{commit}}"], cwd=repo_root,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    if p.returncode != 0:
        raise Refused([f"commit {commit} is not in the repository"])
    full = p.stdout.strip()
    if not reply.strip():
        raise Refused(["the reply is empty"])
    prefix = prd_rel(prd, repo_root)
    version = frontmatter(_show(repo_root, full, "prd.md" if prefix == "." else f"{prefix}/prd.md"))[0].get("version")
    if not version:
        raise Refused([f"commit {commit} has no {prefix}/prd.md version"])
    with repo_lock(repo_root):  # as recover: one prd_deploy command at a time in the repository
        run_id = new_run_id(repo_root, env)
        try:
            now = _iso()
            append(repo_root, run_id, {
                "kind": "header", "by": "hand", "run": run_id, "head": _git(repo_root, "rev-parse", "HEAD").strip(), "commit": full,
                "prd": prefix, "runbook": runbook_hash(prd.root), "version": version, "until": env, "started": now,
            })
            append(repo_root, run_id, {"kind": "hand", "env": env, "commit": full, "reply": reply, "at": now})
        except Exception:
            _log_path(repo_root, run_id).unlink(missing_ok=True)
            raise
        write_deployed_row(prd, env, version, full[:7], f"{run_id[:4]}-{run_id[4:6]}-{run_id[6:8]}", run_id)
    return run_id


# ---- the close check (spec section 5, step 4) ----

ONLY = "only Deployed rows and Status: lines may change"
BY_HAND_STATUS = "a by-hand record moves no status"
# templates/prd/errors.md's placeholder; the close that adds the ledger's first entry may remove it
LEDGER_PLACEHOLDER = "No entries yet. Add `### E-001 <title>` when the first error is diagnosed."
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _levels_passed(steps: list[dict], step: Step) -> bool:
    """Every planned level of a tests step has a `pass` record."""
    return all(any(r.get("step") == step.number and r.get("level") == lv and r.get("result") == "pass" for r in steps) for lv in step.tests or [])


def finished_envs(log: list[dict], prd: Prd) -> list[str]:
    """Environments whose last runbook step has a `pass` in the log, every planned level of each of their tests steps
    has a `pass` record, and no step started on them without finishing."""
    steps = [r for r in log if r.get("kind") == "step"]
    unfinished = {r.get("env") for r in unfinished_starts(log)}
    last: dict[str, int] = {}
    for s in prd.operations.steps:
        if s.env:
            last[s.env] = s.number
    out = []
    for env, number in last.items():
        if env in unfinished:
            continue
        if not all(_levels_passed(steps, s) for s in prd.operations.steps if s.env == env and s.tests is not None):
            continue
        recs = [r for r in steps if r.get("step") == number]
        if recs and recs[-1].get("result") == "human":  # a human step passes once confirmed and resumed, with nothing failing after it
            idx = [i for i, r in enumerate(log) if r.get("kind") == "confirm" and r.get("step") == number]
            ok = bool(idx) and (bool(recs[-1].get("confirmed_ahead")) or any(r.get("kind") == "resume" and r.get("step") == number for r in log[idx[-1] + 1:]))
            later_fail = any(r.get("kind") == "step" and r.get("result") == "fail" and (r.get("step") or 0) > number for r in log)
            if ok and not later_fail:
                out.append(env)
        elif recs and all(r.get("result") == "pass" for r in recs):
            out.append(env)
    return out


def _tree(repo_root: Path, rev: str, prefix: str, dest: Path) -> Path:
    """The PRD folder as it is at `rev`, written under `dest`; its root is returned."""
    names = _git(repo_root, "ls-tree", "-r", "--name-only", "-z", rev, "--", prefix).split("\0")
    root = dest / "prd"
    root.mkdir(parents=True)
    for name in filter(None, names):
        rel = name if prefix == "." else name[len(prefix) + 1:]
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(_show(repo_root, rev, name), encoding="utf-8")
    return root


def _status_cell_mask(line: str) -> str:
    cells = line.split("|")
    if len(cells) >= 7:  # | id | title | status | file | since |
        cells[3], cells[5] = "", ""
    return "|".join(cells)


_SEP = re.compile(r"^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*){4}\|$")
_HEADER = ["Environment", "PRD version", "Commit", "Date", "Run"]


def _deployed_section(text: str):
    return next((s for s in sections(text) if s.title.strip().lower() == "deployed"), None)


def _created_ok(prd: Prd) -> bool:
    """A newly created Deployed section holds exactly its heading, header row, separator row and rows."""
    s = _deployed_section(prd.docs.get("operations.md", ""))
    if s is None:
        return False
    rows = {r.line for r in prd.operations.deployed}
    rest = [t.strip() for n, t in s.body if t.strip() and n not in rows]
    return len(rest) == 2 and [c.strip() for c in rest[0].strip("|").split("|")] == _HEADER and bool(_SEP.match(rest[1]))


def _mask(prd: Prd, rel: str, text: str, created: bool = False) -> list[tuple[int, str]]:
    """The file's non-blank lines with the lines the close may change blanked out; (line number, text)."""
    lines = text.split("\n")
    drop: set[int] = set()
    if rel == "operations.md":
        drop.update(r.line for r in prd.operations.deployed)  # only the data rows
        s = _deployed_section(text)
        if created and s is not None and _created_ok(prd):
            drop.update([s.line] + [n for n, _ in s.body])
    elif rel in prd.docs and (rel == "nfr.md" or re.fullmatch(r"features/[^/]+\.md", rel)):
        for b in prd.blocks:
            if b.file == rel:
                n = next((n for n, t in b.lines if t.startswith("Status:")), None)
                if n:
                    lines[n - 1] = "Status:"
    elif rel == "prd.md":
        for r in prd.index:
            lines[r.line - 1] = _status_cell_mask(lines[r.line - 1])
    return [(n, t) for n, t in enumerate(lines, 1) if n not in drop and t.strip()]


def _diff_lines(base: list[tuple[int, str]], head: list[tuple[int, str]]) -> list[int]:
    """The first head line of each differing stretch."""
    sm = difflib.SequenceMatcher(None, [t for _, t in base], [t for _, t in head], autojunk=False)
    out = []
    for tag, _, _, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        out.append(head[j1][0] if j1 < len(head) else (head[-1][0] if head else 1))
    return out


def detected_names_failure(detected: str | None, run_id: str, step) -> bool:
    """A run entry's `Detected:` line names the run id and `step N`; `step` None accepts any step."""
    pat = r"\d+" if step is None else str(step)  # outside the f-string: a backslash in its expression is a SyntaxError before 3.12
    return bool(detected and re.search(rf"\bstep\s+{pat}\b", detected) and run_id in detected)


def close_findings(prd: Prd, repo_root: Path, run_id: str, rng: str) -> list[str]:
    """Findings for a run's close commit(s); BadRange for a bad range, ValueError for an unusable log."""
    m = re.match(r"^([^.\s][^\s]*?)\.\.([^.\s][^\s]*)$", rng)
    if not m or "..." in rng:
        raise BadRange(f"bad range {rng}: expected <base>..<head>")
    base, head = _resolve(repo_root, rng, m.group(1)), _resolve(repo_root, rng, m.group(2))
    header, recs = _load_log(repo_root, run_id)
    wrong = other_prd(prd, repo_root, run_id, header)
    if wrong:
        return [f"refused: {wrong}"]
    run_head = str(header.get("head"))
    if base != run_head:
        return [f"the range must start at the run's HEAD {run_head[:7]}"]
    if subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=repo_root, capture_output=True, timeout=60).returncode != 0:
        return ["the range's head does not descend from the run's HEAD"]
    prefix = prd_rel(prd, repo_root)
    with tempfile.TemporaryDirectory(prefix="prd-deploy-check-") as tmp:
        try:
            b_prd, h_prd = (load(_tree(repo_root, rev, prefix, Path(tmp) / name)) for rev, name in ((base, "base"), (head, "head")))
        except Exception as e:
            raise BadRange(f"cannot load the PRD at {base[:7]} and {head[:7]}: {e}") from None
    out: list[str] = []
    version = header.get("version")
    by_hand = header.get("by") == "hand"
    if by_hand:  # record's log: its one environment is finished, at the recorded commit, and no status may move
        finished = [r.get("env") for r in recs if r.get("kind") == "hand"][:1]
        deployed_commit, commit_name = str(header.get("commit")), f"the recorded commit {str(header.get('commit'))[:7]}"
    else:
        finished = finished_envs(recs, b_prd)
        deployed_commit, commit_name = run_head, "the run's HEAD"
    prod_finished = not by_hand and bool(production_envs(b_prd) & set(finished))
    failed = next((r for r in recs if r.get("kind") == "step" and r.get("result") == "fail"), None)
    if failed is None:  # a step that started and has no record (its record could not be written, or the call was killed) failed too
        failed = next(iter(unfinished_starts(recs)), None)
    m_date = re.match(r"(\d{4})(\d{2})(\d{2})T", run_id)
    run_date = "-".join(m_date.groups()) if m_date else None

    # Deployed rows
    base_rows = {(r.env, r.version, r.commit, r.date, r.run) for r in b_prd.operations.deployed}
    seen: dict[str, int] = {}
    for r in h_prd.operations.deployed:
        seen[r.env] = seen.get(r.env, 0) + 1
    for r in h_prd.operations.deployed:
        if (r.env, r.version, r.commit, r.date, r.run) in base_rows:
            continue
        if r.env not in finished:
            out.append(f"Deployed {r.env}: the run did not finish {r.env}")
            continue
        if r.version != version:
            out.append(f"Deployed {r.env}: version {r.version}, the run deployed {version}")
        if len(r.commit) < 7 or not deployed_commit.startswith(r.commit.lower()):
            out.append(f"Deployed {r.env}: commit {r.commit} is not {commit_name}")
        if r.run != run_id:
            out.append(f"Deployed {r.env}: run {r.run} is not {run_id}")
        if not _DATE.fullmatch(r.date):
            out.append(f"Deployed {r.env}: date {r.date} is not YYYY-MM-DD")
        elif run_date and r.date != run_date:
            out.append(f"Deployed {r.env}: date {r.date} is not the run's date {run_date}")
    new_rows = {r.env for r in h_prd.operations.deployed if (r.env, r.version, r.commit, r.date, r.run) not in base_rows}
    out += [f"Deployed: {env} finished in this run but has no row for it" for env in finished if env not in new_rows]
    out += [f"Deployed {env}: more than one row" for env, n in seen.items() if n > 1]
    kept = set(seen)
    out += [f"Deployed {r.env}: a row may be replaced, not removed" for r in b_prd.operations.deployed if r.env not in kept]

    # statuses
    base_blocks = {b.id: b for b in b_prd.blocks}
    head_blocks = {b.id: b for b in h_prd.blocks}
    for bid, hb in head_blocks.items():
        bb = base_blocks.get(bid)
        if bb is not None and (bb.status, bb.since) != (hb.status, hb.since):
            if by_hand:
                out.append(f"{bid}: {BY_HAND_STATUS}")
            elif not prod_finished:
                out.append(f"{bid}: {hb.status} after a run that did not finish production")
            elif bb.status != "verified" or hb.status != "live":
                out.append(f"{bid}: {bb.status} to {hb.status}; only verified to live may change")
            elif hb.since != version:
                out.append(f"{bid}: since {hb.since}, the run deployed {version}")
        if prod_finished and hb.status == "verified":
            out.append(f"{bid}: still verified after a production finish")
    base_idx = {r.id: (r.status, r.since) for r in b_prd.index}
    for r in h_prd.index:
        hb, bb = head_blocks.get(r.id), base_blocks.get(r.id)
        changed = base_idx.get(r.id) != (r.status, r.since)
        if hb is None:
            if changed:
                out.append(f"{r.id}: the §11 index row changed but the PRD has no block {r.id}")
            continue
        moved = changed or (bb is not None and (bb.status, bb.since) != (hb.status, hb.since))
        if moved and (r.status, r.since) != (hb.status, hb.since):
            out.append(f"{r.id}: the §11 index says {r.status} since {r.since}, the block says {hb.status} since {hb.since}")

    # errors.md
    new = [e for i, e in h_prd.errors_ledger.items() if i not in b_prd.errors_ledger]
    drop_errors: set[int] = set()
    if failed is not None and not new:
        out.append(f"errors.md: the run failed at step {failed.get('step')} but no open unclassified entry was added")
    if failed is not None and len(new) == 1:
        e = new[0]
        etext = "\n".join(h_prd.docs["errors.md"].split("\n")[e.line - 1:e.end])
        detected = re.search(r"^Detected:.*$", etext, re.M)
        line = detected.group(0) if detected else None
        step_ok = detected_names_failure(line, run_id, failed.get("step"))
        run_entry = e.open and e.classification == "unclassified" and detected_names_failure(line, run_id, None)
        if run_entry and not step_ok:  # a mid-run entry, kept as it is: the failed step's own entry is the one missing
            out.append(f"errors.md: the run failed at step {failed.get('step')} but no open unclassified entry names run {run_id} and that step in Detected:")
        elif not (e.open and e.classification == "unclassified" and step_ok):
            out.append(f"{prefix + '/' if prefix != '.' else ''}errors.md:{e.line}: the entry must be open, unclassified, and name run {run_id} and failed step {failed.get('step')} in Detected:")
        drop_errors = set(range(e.line, e.end + 1))
    names_failure = False
    if failed is None or len(new) != 1:  # a run's entries, recorded while it was stopped or after it failed, ride the close
        for e in new:
            etext = "\n".join(h_prd.docs["errors.md"].split("\n")[e.line - 1:e.end])
            detected = re.search(r"^Detected:.*$", etext, re.M)
            line = detected.group(0) if detected else None
            if e.open and e.classification == "unclassified" and detected_names_failure(line, run_id, None):
                drop_errors |= set(range(e.line, e.end + 1))
                names_failure = names_failure or (failed is not None and detected_names_failure(line, run_id, failed.get("step")))
        if failed is not None and new and not names_failure:
            out.append(f"errors.md: the run failed at step {failed.get('step')} but no open unclassified entry names run {run_id} and that step in Detected:")
    first_entry = bool(drop_errors) and not b_prd.errors_ledger

    # every other change
    diff = _git(repo_root, "diff", "--no-renames", "--name-only", "-z", base, head).split("\0")
    for path in dict.fromkeys(filter(None, diff)):
        rel = path[len(prefix) + 1:] if prefix != "." and path.startswith(prefix + "/") else (path if prefix == "." else None)
        b_text, h_text = _show(repo_root, base, path), _show(repo_root, head, path)
        if rel is None:
            bl = [(n, t) for n, t in enumerate(b_text.split("\n"), 1) if t.strip()]
            hl = [(n, t) for n, t in enumerate(h_text.split("\n"), 1) if t.strip()]
        else:
            bl, hl = _mask(b_prd, rel, b_text), _mask(h_prd, rel, h_text, created=_deployed_section(b_prd.docs.get("operations.md", "")) is None)
            if rel == "errors.md":
                hl = [(n, t) for n, t in hl if n not in drop_errors]
                if first_entry:  # removing the placeholder is allowed here, and only here
                    bl, hl = ([(n, t) for n, t in lines if t.strip() != LEDGER_PLACEHOLDER] for lines in (bl, hl))
        out += [f"{path}:{n}: {ONLY}" for n in _diff_lines(bl, hl)]
    return list(dict.fromkeys(out))
