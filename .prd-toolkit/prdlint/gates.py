"""prd_gates.py list, answer, wait and serve: every pending human decision of a PRD in one shape, one reply passed to its
owner, the answer log, and the decision inbox that answers them in the browser."""
import datetime
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path

from . import cardcontext, confirm, deploy, formserver, inboxcards, model
from .formserver import Bad
from .model import Prd

REVIEW_FILE = ".prd-review.json"
PENDING = "; pending"
MAX_EVIDENCE = 20
KIND_ORDER = ("approval", "error-class", "deploy-step", "adoption", "signoff")
# an adoption gate's `choices` is the decisions its open items allow (this order), then `done`
DECISION_ORDER = ("confirm", "correct", "bug", "intended", "fix", "answer", "ask")


@dataclass
class Gate:
    id: str
    kind: str
    title: str
    question: str
    evidence: list[str]
    choices: list[str]
    source: str
    path: str | None = None
    items: list[str] | None = None
    areas: list[str] | None = None  # FR-062, set by cardcontext.attach when the gate is listed
    url: str | None = None  # FR-066

    def to_dict(self) -> dict:
        """The gate's keys as before card-context, `path` and `items` only where set; then `areas` and `url` (null kept)."""
        out = {k: v for k, v in asdict(self).items() if v is not None and k not in ("areas", "url")}
        if self.areas is not None:
            out.update(areas=list(self.areas), url=self.url)
        return out


def _git(cwd: Path, *args: str) -> str:
    run = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    return run.stdout if run.returncode == 0 else ""


def branch_of(root: Path) -> str:
    """The checked-out branch of the worktree holding `root`; `HEAD` when detached."""
    return _git(root, "branch", "--show-current").strip() or "HEAD"


def _last_row(prd: Prd):
    from .change import _table_of

    text = prd.docs.get("prd.md", "")
    table = _table_of(text, 14)
    return table.rows[-1] if table and table.rows else None


# the verdict keys `list` reads or a client may, with the type each must have; `touches` and `dry_run` are required;
# `refs` (0.8.2, optional) is the approval commit's trailer IDs for a change made for an errors.md entry (one line);
# `base` (0.8.3, optional) is the full SHA the review diffed against
VERDICT_TYPES = {"interface": int, "kind": str, "head": str, "digest": str, "restate": str, "touches": list, "impact": dict,
                 "bump": dict, "dry_run": dict, "ready": bool, "blockers": list, "owner": dict, "refs": str, "base": str}
VERDICT_REQUIRED = ("digest", "touches", "dry_run", "ready")


def verdict_shape_ok(verdict) -> bool:
    """True when the verdict is an object whose known keys have their types; a wrong shape is no gate, as invalid JSON is."""
    if not isinstance(verdict, dict) or any(k not in verdict for k in VERDICT_REQUIRED):
        return False
    for key, kind in VERDICT_TYPES.items():
        value = verdict.get(key)
        if key in verdict and (not isinstance(value, kind) or (kind is int and isinstance(value, bool))):
            return False
    if "\n" in verdict.get("refs", "") or "\r" in verdict.get("refs", ""):
        return False
    record = verdict["dry_run"].get("record")
    return record is None or isinstance(record, str)


# --- a PRD loaded once per state of its folder: the inbox lists every worktree's PRD every few seconds, and a load takes
# seconds, so a listing loads again only a PRD whose folder changed (E-068) ---

_LOADED: dict[Path, tuple[str, Prd]] = {}
_LOADED_LOCK = threading.Lock()


def _fingerprint(prd_dir: Path) -> str:
    """SHA-1 over every entry under the folder in sorted order: its relative path, and a file's bytes. Raises OSError."""
    h = hashlib.sha1()
    for p in sorted(prd_dir.rglob("*")):
        h.update(p.relative_to(prd_dir).as_posix().encode("utf-8") + b"\0")
        h.update(b"f" + p.read_bytes() + b"\0" if p.is_file() else b"-\0")
    return h.hexdigest()


def load_unchanged(prd_dir: Path) -> Prd:
    """`model.load(prd_dir)`, returning the Prd loaded before while no file under the folder has changed since. The Prd is
    shared, so callers only read it. A folder whose files cannot be read is loaded as `model.load` loads it."""
    prd_dir = Path(prd_dir).resolve()
    try:
        mark = _fingerprint(prd_dir)
    except OSError:
        return model.load(prd_dir)
    with _LOADED_LOCK:
        hit = _LOADED.get(prd_dir)
    if hit is not None and hit[0] == mark:
        return hit[1]
    prd = model.load(prd_dir)
    with _LOADED_LOCK:
        _LOADED[prd_dir] = (mark, prd)
    return prd


def forget_loaded(keep: set[Path]) -> None:
    """Drop every loaded PRD whose folder is not in `keep` (a worktree removed while the inbox runs)."""
    with _LOADED_LOCK:
        for key in [k for k in _LOADED if k not in keep]:
            del _LOADED[key]


def approval_gate(prd_root: Path, branch: str, path: str | None = None) -> Gate | None:
    """Pending when a ready verdict of the right shape has the PRD's digest and the last §14 row ends `; pending`."""
    from .change import digest

    verdict_path = Path(prd_root) / REVIEW_FILE
    try:
        verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not verdict_shape_ok(verdict) or verdict["ready"] is not True:
        return None
    prd = load_unchanged(Path(prd_root))
    if verdict["digest"] != digest(prd_root, prd):
        return None
    last = _last_row(prd)
    if last is None or len(last.cells) < 3 or not last.cells[2].endswith(PENDING):
        return None
    slug, version = prd.frontmatter.get("prd", Path(prd_root).name), last.cells[0]
    record = verdict["dry_run"].get("record")
    touches = [str(t) for t in verdict["touches"]]
    evidence = ([record] if record else []) + ([f"touches: {', '.join(touches)}"] if touches else [])
    restate = verdict.get("restate") or last.cells[2][:-len(PENDING)]
    gate = Gate(f"approval:{branch}", "approval", f"Approve {slug} {version}", f"{restate} Approve it, or send it back with changes?",
                evidence[:MAX_EVIDENCE], ["approve", "changes"], REVIEW_FILE, path=path)
    return cardcontext.attach(prd, gate, touches)  # its areas come from its own worktree's PRD


def _approval(prd: Prd, repo_root: Path, worktrees: bool) -> list[Gate]:
    here = repo_root.resolve()
    found = []
    mine = approval_gate(prd.root, branch_of(prd.root), str(here) if worktrees else None)
    if mine:
        found.append(mine)
    if not worktrees:
        return found
    rel = prd.root.resolve().relative_to(here)
    for wt in _worktree_entries(repo_root):
        root = Path(wt["worktree"]).resolve()
        if root == here or "bare" in wt:
            continue
        branch = wt.get("branch", "").removeprefix("refs/heads/") or "HEAD"
        try:
            gate = approval_gate(root / rel, branch, str(root))
        except Exception:
            continue
        if gate:
            found.append(gate)
    return found


def _error_class(prd: Prd) -> list[Gate]:
    return [Gate(f"error-class:{e.id}", "error-class", e.title, f"Proposed class: {e.classification}. Confirm it, or correct it to another class.",
                 [str(x) for x in e.evidence[:MAX_EVIDENCE]], ["confirm", "correct", "question"], f"errors.md:{e.line}")
            for e in prd.errors_ledger.values() if e.state == "proposed"]


def _deploy_step(prd: Prd, repo_root: Path) -> list[Gate]:
    try:
        run_ids = sorted(p.stem for p in deploy.log_dir(repo_root).glob("*.jsonl"))
        mine = deploy.prd_rel(prd, repo_root)
    except Exception:
        return []
    steps = {s.number: s for s in prd.operations.steps}
    out = []
    for run_id in run_ids:
        try:
            recs = _read_run_log(repo_root, run_id)
        except FileNotFoundError:
            continue  # removed since the listing
        except Exception as e:  # noqa: BLE001 - a log that cannot be read is a gate of its own, never no gate
            if _header_prd(repo_root, run_id) in (None, mine):
                out.append(_unreadable_gate(run_id, e))
            continue
        if not recs or recs[0].get("kind") != "header" or recs[0].get("prd") != mine:
            continue
        last = deploy._last_step(recs)
        if not last or last.get("result") != "human" or deploy._confirmed(recs, last["step"]):
            continue
        n, step = last["step"], steps.get(last["step"])
        do = step.labels.get("Do", ("", 0))[0] if step else ""
        check = step.labels.get("Check", ("", 0))[0] if step else ""
        title = f"Run {run_id} step {n}: {step.title}" if step else f"Run {run_id} step {n}"
        question = f"{step.title if step else 'Human step'}. {do}".strip()
        out.append(Gate(f"deploy-step:{run_id}:{n}", "deploy-step", title, question,
                        [f"Check: {check}"] if check else [], ["confirm"], "operations.md"))
    return out


UNREADABLE = "unreadable"


def _read_run_log(repo_root: Path, run_id: str) -> list[dict]:
    """The run's records; ValueError when a line is not JSON or a record is not a JSON object."""
    recs = deploy.read_log(repo_root, run_id)
    bad = next((n for n, rec in enumerate(recs, 1) if not isinstance(rec, dict)), None)
    if bad is not None:
        raise ValueError(f"record {bad} is not a JSON object")
    return recs


def _header_prd(repo_root: Path, run_id: str) -> str | None:
    """The PRD folder the first line of an unreadable log names, when that line is a readable header; else None."""
    try:
        text = deploy._log_path(repo_root, run_id).read_text(encoding="utf-8", errors="replace")
        first = next((line for line in text.split("\n") if line.strip()), "")
        head = json.loads(first)
    except (OSError, ValueError):
        return None
    prd = head.get("prd") if isinstance(head, dict) and head.get("kind") == "header" else None
    return prd if isinstance(prd, str) and prd else None


def _unreadable_gate(run_id: str, error: Exception) -> Gate:
    """A run log that cannot be read (fix 7 of 0.8.4): listed with the reason, its first line, and answered by nothing."""
    reason = next((line.strip() for line in str(error).splitlines() if line.strip()), type(error).__name__)
    return Gate(f"deploy-step:{run_id}:{UNREADABLE}", "deploy-step", f"run log {run_id} could not be read", reason, [], [],
                "operations.md")


def unreadable_run(gate: Gate) -> str | None:
    """The run id of an unreadable run log's gate; None for any other gate."""
    if gate.kind != "deploy-step" or not gate.id.endswith(f":{UNREADABLE}"):
        return None
    return gate.id.split(":", 1)[1].rsplit(":", 1)[0]


def _adoption(prd: Prd, repo_root: Path) -> list[Gate]:
    out = []
    for row in prd.adoption or []:
        if row.state != "extracted":
            continue
        path = confirm.answers_path(repo_root, row.area)
        try:
            answers = confirm.load_answers(path)
        except confirm.Refused:
            answers = {}
        if not path.is_file() or answers.get("done") is True:
            continue
        try:
            items = confirm.build_items(prd, row.area)
        except confirm.Refused:
            items = []
        open_ids = set(confirm.open_ids(items, answers))
        kinds = {i.kind for i in items if i.id in open_ids}
        allowed = {d for k in kinds for d in confirm.ALLOWED[k]}
        choices = [d for d in DECISION_ORDER if d in allowed] + ["done"]
        out.append(Gate(f"adoption:{row.area}", "adoption", f"Adopt area {row.area}",
                        f"{len(open_ids)} of {len(items)} items of area {row.area} are open. Answer each, then mark the area done.",
                        [], choices, path.name, items=[i.id for i in items if i.id in open_ids]))
    return out


def _signoff(prd: Prd) -> list[Gate]:
    done = {r.cells[0] for r in prd.testing.signoffs if len(r.cells) > 3 and r.cells[3].strip()}
    out = []
    for tc in prd.test_cases:
        owner = tc.data.get("signoff")
        if tc.data.get("level") != "acceptance" or not owner or tc.id in done:
            continue
        steps = [str(s) for s in (tc.data.get("steps") or [])][:MAX_EVIDENCE]
        out.append(Gate(f"signoff:{tc.id}", "signoff", f"Sign off {tc.id}",
                        f"{owner} walks the steps of {tc.id} and reports the result: pass or fail.", steps, ["pass", "fail"], f"{tc.file}:{tc.line}"))
    return out


def list_gates(prd: Prd, repo_root: Path, worktrees: bool = False) -> list[Gate]:
    """Every pending gate, in the kind order of KIND_ORDER, then by id."""
    others = _error_class(prd) + _deploy_step(prd, Path(repo_root)) + _adoption(prd, Path(repo_root)) + _signoff(prd)
    gates = _approval(prd, Path(repo_root), worktrees) + [cardcontext.attach(prd, g) for g in others]
    return sorted(gates, key=lambda g: (KIND_ORDER.index(g.kind), g.id))


# --- answer: one reply for one gate, passed to the script that owns the decision ---

SCRIPTS = Path(__file__).resolve().parent.parent  # the scripts beside this package, so a vendored copy calls vendored scripts
REFUSED_CHANGED = "the gate changed; list again"


class Refused(Exception):
    """A refusal by `answer` itself: nothing ran and nothing was written."""


def _run(script: str, *argv: str) -> dict:
    """Call an owning script as `<this interpreter> <script> argv...`: an argv list, never a shell string."""
    run = subprocess.run([sys.executable, str(SCRIPTS / script), *argv], capture_output=True, text=True, encoding="utf-8",
                         env={**os.environ, "PYTHONUTF8": "1"})
    out = {"stdout": run.stdout.splitlines(), "exit": run.returncode}
    if run.stderr.strip():
        out["stderr"] = run.stderr.splitlines()
    return out


def _atomic_write(path: Path, text: str) -> None:
    """A temp file in the same folder, then os.replace."""
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _relpath(repo_root: Path, path: Path) -> str:
    return Path(path).resolve().relative_to(Path(repo_root).resolve()).as_posix()


def _commit_write(repo_root: Path, rel: str, message: str) -> str | None:
    """R19: commit the owner's write to one file by path only (`git commit -- <path>`), so other staged work stays staged.

    Returns None when committed, else the git error; on an error the write stays in the tree and nothing stays staged."""
    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=repo_root, capture_output=True, text=True, encoding="utf-8")

    added = False
    if git("ls-files", "--error-unmatch", "--", rel).returncode != 0:  # an untracked ledger: `commit -- <path>` needs it known
        run = git("add", "--", rel)
        if run.returncode != 0:
            return (run.stderr or run.stdout).strip() or f"git add exited {run.returncode}"
        added = True
    with tempfile.TemporaryDirectory(prefix="prd-gates-") as tmp:
        msg = Path(tmp) / "message"
        msg.write_text(message, encoding="utf-8")
        run = git("commit", "-q", "--cleanup=verbatim", "-F", str(msg), "--", rel)
    if run.returncode != 0:
        if added:
            git("rm", "-q", "--cached", "--", rel)
        return (run.stderr or run.stdout).strip() or f"git commit exited {run.returncode}"
    return None


def _committed(out: dict, repo_root: Path, path: Path, message: str) -> dict:
    """Commit the owner's write when the owner exited 0; a failed commit makes the result exit 1 with git's error on stderr."""
    if out["exit"] != 0:
        return out
    failed = _commit_write(repo_root, _relpath(repo_root, path), message)
    if failed is None:
        return out
    return {**out, "exit": 1, "stderr": [*out.get("stderr", []), *f"git commit failed: {failed}".splitlines()]}


def _requirement_of(prd: Prd, tid: str) -> str:
    """The FR or NFR a T-id belongs to: the block that lists it, else the block numbered like its AC; the T-id when neither."""
    from .change import _owner_ac

    blocks = [b for b in prd.blocks if b.kind in ("FR", "NFR")]
    listed_in = next((b.id for b in blocks if tid in {t[0] for t in b.tests}), None)
    if listed_in:
        return listed_in
    case = next((tc for tc in prd.test_cases if tc.id == tid), None)
    m = re.fullmatch(r"AC-(\d+)\.\d+", _owner_ac(case)) if case else None
    return next((b.id for b in blocks if m and int(b.id.split("-")[1]) == int(m.group(1))), tid)


def _pick(gate: Gate, choice: str | None, default: str) -> str:
    choice = choice or default
    if choice not in gate.choices:
        raise Refused(f"{gate.id} offers {', '.join(gate.choices)}, not {choice}")
    return choice


def _answer_approval(prd: Prd, gate: Gate, reply: str, choice: str | None, **_) -> dict:
    choice = _pick(gate, choice, "approve")
    root = Path(prd.root)
    if choice == "changes":
        path = root / REVIEW_FILE
        verdict = json.loads(path.read_text(encoding="utf-8"))
        verdict["owner"] = {"choice": "changes", "reply": reply, "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        verdict["ready"] = False
        verdict["blockers"] = [*(verdict.get("blockers") or []), f"owner: {reply}"]
        _atomic_write(path, json.dumps(verdict, ensure_ascii=False, indent=2) + "\n")
        return {"stdout": [f"recorded changes for {gate.id}"], "exit": 0}
    verdict = json.loads((root / REVIEW_FILE).read_text(encoding="utf-8"))
    record = (verdict.get("dry_run") or {}).get("record")
    if not record:
        raise Refused("the verdict holds no dry-run record")
    refs = verdict.get("refs")
    extra = [f"--refs={refs}"] if isinstance(refs, str) and refs.strip() else []
    return _run("prd_change.py", "approve", str(root), f"--reply={reply}", f"--dry-run={record}", *extra)


def _answer_error_class(prd: Prd, gate: Gate, reply: str, choice: str | None, cls: str | None, repo_root: Path, **_) -> dict:
    choice = _pick(gate, choice, "confirm")
    if choice == "correct" and not cls:
        raise Refused("--choice correct needs --class")
    if choice in ("confirm", "question") and cls:
        raise Refused("--class goes with --choice correct")
    if choice == "question":  # AC-254.3: a question is logged for `wait`; nothing is written or committed
        return {"stdout": [f"recorded a question for {gate.id}"], "exit": 0}
    extra = [f"--class={cls}"] if choice == "correct" else []
    eid = gate.id.split(":", 1)[1]
    out = _run("prd_error.py", "confirm", str(prd.root), eid, f"--reply={reply}", *extra)
    # handling-errors' confirm commit (running-an-error.md step 4), errors.md alone
    return _committed(out, repo_root, Path(prd.root) / "errors.md", f"docs(prd): confirm {eid}\n\nRefs: {eid}\n")


def _answer_deploy_step(prd: Prd, gate: Gate, reply: str, choice: str | None, **_) -> dict:
    _pick(gate, choice, "confirm")
    run_id, step = gate.id.split(":", 1)[1].rsplit(":", 1)
    return _run("prd_deploy.py", "confirm", str(prd.root), "--run", run_id, "--step", step, f"--reply={reply}")


def _answer_adoption(prd: Prd, gate: Gate, reply: str, choice: str | None, item: str | None, correction: str | None, repo_root: Path, **_) -> dict:
    area = gate.id.split(":", 1)[1]
    if choice == "done":
        if item is not None:
            raise Refused("--item does not apply to --choice done")
        return _run("prd_confirm.py", "done", str(prd.root), area)
    if not item or not choice:
        raise Refused("an adoption answer needs --item with --choice, or --choice done")
    try:
        by_id = {i.id: i for i in confirm.build_items(prd, area)}
    except confirm.Refused as e:
        raise Refused(str(e)) from None
    if item not in by_id:
        raise Refused(f"unknown item {item!r}")
    allowed = confirm.ALLOWED[by_id[item].kind]
    if choice not in allowed:
        raise Refused(f"{item} cannot be answered {choice}; allowed: {', '.join(sorted(allowed))}")
    extra = [f"--correction={correction}"] if correction is not None else []
    return _run("prd_confirm.py", "answer", str(prd.root), area, item, "--decision", choice, f"--reply={reply}", *extra)


def _answer_signoff(prd: Prd, gate: Gate, reply: str, choice: str | None, result: str | None, repo_root: Path, **_) -> dict:
    """`--result` is required and is the sign-off; `--choice`, when given, must equal it."""
    if result is None:
        raise Refused("signoff needs --result pass|fail")
    if result not in ("pass", "fail"):
        raise Refused("--result must be pass or fail")
    if choice is not None and choice != result:
        raise Refused(f"--choice {choice} disagrees with --result {result}")
    tid = gate.id.split(":", 1)[1]
    case = next(tc for tc in prd.test_cases if tc.id == tid)
    row = f"| {tid} | {case.data.get('signoff')} | {datetime.date.today().isoformat()} | {result} |"
    path = Path(prd.root) / "testing.md"
    with path.open(encoding="utf-8", newline="") as f:  # newline="" keeps CRLF as it is
        raw = f.read()
    eol = "\r\n" if "\r\n" in raw else "\n"
    text = _with_signoff_row(raw.replace("\r\n", "\n"), tid, row)
    _atomic_write(path, text.replace("\n", eol) if eol != "\n" else text)
    return _committed({"stdout": [row], "exit": 0}, repo_root, path, f"docs(prd): sign off {tid}\n\nRefs: {_requirement_of(prd, tid)}\n")


def _with_signoff_row(text: str, tid: str, row: str) -> str:
    """Append `row` to the Sign-offs table, or fill the row that names `tid` and holds no result."""
    lines = text.split("\n")
    start = next((n for n, ln in enumerate(lines) if re.match(r"^#+\s*Sign-offs\s*$", ln)), None)
    if start is None:
        raise Refused("testing.md has no Sign-offs section")
    end = next((n for n in range(start + 1, len(lines)) if lines[n].startswith("#")), len(lines))
    table = [n for n in range(start + 1, end) if lines[n].startswith("|")]
    if not table:
        body = [lines[n] for n in range(start + 1, end) if lines[n].strip() not in ("", "None.", "None")]
        lines[start + 1:end] = ["", "| T-id | Owner | Date | Result |", "|---|---|---|---|", row, "", *body]
        return "\n".join(lines)
    for n in table:
        cells = [c.strip() for c in lines[n].strip().strip("|").split("|")]
        if cells[0] == tid and len(cells) > 3 and not cells[3]:
            lines[n] = row
            return "\n".join(lines)
    lines.insert(table[-1] + 1, row)
    return "\n".join(lines)


# the optional flags each kind takes (`--question` and the reply apply to all)
FLAGS = {"approval": {"choice"}, "error-class": {"choice", "cls"}, "deploy-step": {"choice"},
         "adoption": {"choice", "item", "correction"}, "signoff": {"choice", "result"}}
FLAG_NAMES = {"choice": "--choice", "cls": "--class", "result": "--result", "item": "--item", "correction": "--correction"}


ANSWERERS = {"approval": _answer_approval, "error-class": _answer_error_class, "deploy-step": _answer_deploy_step,
             "adoption": _answer_adoption, "signoff": _answer_signoff}


def answer(prd: Prd, repo_root: Path, gate_id: str, reply: str, choice: str | None = None, cls: str | None = None,
           result: str | None = None, item: str | None = None, correction: str | None = None, question: str | None = None,
           by: str = "cli") -> dict:
    """Pass one reply for one gate to its owner: `{gate, result}`, `result` being the owner's `{stdout, exit}`. Raises Refused.
    After the owner exits 0 one line goes to the answer log (an adoption's per-item answers excepted: only its `done`)."""
    if not isinstance(reply, str) or not reply.strip():
        raise Refused("the reply is empty")
    for name, value in (("reply", reply), ("correction", correction), ("question", question), ("choice", choice), ("class", cls),
                        ("result", result), ("item", item)):
        if value is not None and "\x00" in value:
            raise Refused(f"--{name} holds a NUL character")
    gate = next((g for g in list_gates(prd, repo_root) if g.id == gate_id), None)
    if gate is None or (question is not None and gate.question != question):
        raise Refused(REFUSED_CHANGED)
    unreadable = unreadable_run(gate)
    if unreadable:
        raise Refused(f"run log {unreadable} could not be read: {gate.question}")
    given = {"choice": choice, "cls": cls, "result": result, "item": item, "correction": correction}
    for key, value in given.items():
        if value is not None and key not in FLAGS[gate.kind]:
            raise Refused(f"{FLAG_NAMES[key]} does not apply to {gate.kind}")
    marker = _mark_answering(Path(repo_root), gate.id)
    try:
        out = ANSWERERS[gate.kind](prd, gate, reply, choice=choice, cls=cls, result=result, item=item, correction=correction, repo_root=Path(repo_root))
        if out.get("exit") == 0 and not (gate.kind == "adoption" and choice != "done"):
            # a deploy step's one choice is confirm: an answered gate never logs null, which is wait's "not pending"
            logged = choice or {"approval": "approve", "error-class": "confirm", "deploy-step": "confirm", "signoff": result}.get(gate.kind)
            _append_log(Path(repo_root), prd, gate.id, logged, reply, by)
    finally:
        marker.unlink(missing_ok=True)
    return {"gate": gate.id, "result": out}


# --- the answer log: one line per accepted answer, in the git common dir shared by every worktree ---

LOG_NAME = "prd-gates-log.jsonl"


def common_dir(repo_root: Path) -> Path:
    out = _git(Path(repo_root), "rev-parse", "--git-common-dir").strip()
    return (Path(repo_root) / out).resolve()


def log_path(repo_root: Path) -> Path:
    return common_dir(repo_root) / LOG_NAME


def read_log(repo_root: Path) -> list[dict]:
    try:
        text = log_path(repo_root).read_text(encoding="utf-8")
    except OSError:
        return []
    lines = []
    for raw in text.splitlines():
        try:
            doc = json.loads(raw)
        except ValueError:
            continue
        if isinstance(doc, dict):
            lines.append(doc)
    return lines


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append_log(repo_root: Path, prd: Prd, gate_id: str, choice: str | None, reply: str, by: str) -> None:
    line = {"at": _now(), "prd": prd.frontmatter.get("prd", Path(prd.root).name), "worktree": str(Path(repo_root).resolve()),
            "gate": gate_id, "choice": choice, "reply": reply, "by": by}
    with log_path(repo_root).open("a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
            f.flush()
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


# --- the answering marker: `answer` holds it from before the owner runs until its log line is written, so `wait` can
# tell an owner still at work (the gate gone, the line not yet there) from a gate that changed under it ---

ANSWERING_DIR = "prd-gates-answering"
MARKER_MAX_AGE = 15 * 60  # seconds: a marker older than this is stale (a killed `answer` whose pid may be reused)


def answering_dir(repo_root: Path) -> Path:
    return common_dir(repo_root) / ANSWERING_DIR


def gate_key(worktree: Path, gate_id: str) -> str:
    """The sha1 of the resolved worktree, NUL, gate id; a deploy step is repo-wide, as its log match is, so its key is the
    gate id alone."""
    where = "" if gate_id.startswith("deploy-step:") else str(Path(worktree).resolve())
    return hashlib.sha1(f"{where}\0{gate_id}".encode("utf-8")).hexdigest()


def answering_path(repo_root: Path, gate_id: str) -> Path:
    """<git common dir>/prd-gates-answering/<gate_key(repo_root, gate_id)>."""
    return answering_dir(repo_root) / gate_key(repo_root, gate_id)


def _mark_answering(repo_root: Path, gate_id: str) -> Path:
    path = answering_path(repo_root, gate_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{os.getpid()}\n", encoding="utf-8")
    return path


def _answering(repo_root: Path, gate_id: str) -> bool:
    """True while a marker for the gate names a live process and is younger than MARKER_MAX_AGE. A marker whose pid is
    dead, or that is older (a killed `answer`, its pid perhaps reused), counts as absent and is removed."""
    path = answering_path(repo_root, gate_id)
    try:
        raw = path.read_text(encoding="utf-8")
        age = time.time() - path.stat().st_mtime
    except OSError:
        return False
    try:
        pid = int(raw.strip())
    except ValueError:
        pid = 0
    if pid > 0 and age <= MARKER_MAX_AGE and _alive(pid):
        return True
    try:
        if path.read_text(encoding="utf-8") == raw:  # never one a newer `answer` wrote since
            path.unlink()
    except OSError:
        pass
    return False


# --- the waiting marker: each running `wait` holds one, so the inbox can tell a gate some session waits on from one
# nobody waits on (a session that ended, died or moved its work) ---

WAITING_DIR = "prd-gates-waiting"


def waiting_dir(repo_root: Path) -> Path:
    return common_dir(repo_root) / WAITING_DIR


def _mark_waiting(worktree: Path, gate_id: str) -> Path:
    """<git common dir>/prd-gates-waiting/<gate key>-<pid>, holding the pid; one file per waiting process."""
    path = waiting_dir(worktree) / f"{gate_key(worktree, gate_id)}-{os.getpid()}"
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, f"{os.getpid()}\n")  # never read half-written: a temp file (".tmp-…") then a rename
    return path


def waiting(repo_root: Path, worktree: Path, gate_id: str) -> bool:
    """True when a waiting marker for (worktree, gate) names a live process. A marker whose pid is dead is removed; there
    is no age limit, since a `wait` may run for hours."""
    found = False
    for path in waiting_dir(repo_root).glob(f"{gate_key(worktree, gate_id)}-*"):
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            continue
        try:
            pid = int(raw.strip())
        except ValueError:
            pid = 0
        if pid > 0 and _alive(pid):
            found = True
            continue
        try:
            path.unlink()
        except OSError:
            pass
    return found


# --- wait: block until the owner answers one gate (in the form or the chat) ---

GRACE = 1.0  # a gate leaves the list a moment before its log line is written


def _outcome(worktree: Path, gate_id: str, line: dict | None) -> dict:
    line = line or {}
    return {"gate": gate_id, "worktree": str(worktree), "choice": line.get("choice"), "reply": line.get("reply"),
            "by": line.get("by"), "at": line.get("at")}


def wait_gate(prd_dir: Path, gate_id: str, worktree: Path | None = None, timeout: float | None = None, poll: float = 1.0) -> tuple[int, dict]:
    """0 with the first log line for (worktree, gate), or for a deploy-step gate from any worktree, at or after the start; 1 when the gate is not pending (outcome with choice None); 3 on timeout.
    Holds a waiting marker from its start until it returns."""
    started, begun = _now(), time.monotonic()
    prd_dir = Path(prd_dir)
    here = model.repo_root(prd_dir).resolve()
    wt = Path(worktree).resolve() if worktree else here
    root = wt / prd_dir.resolve().relative_to(here)
    try:
        marker = _mark_waiting(wt, gate_id)
    except OSError:  # the marker only informs the inbox: a wait without one runs as before it existed
        marker = None
    try:
        return _wait(root, wt, gate_id, started, begun, timeout, poll)
    finally:
        if marker is not None:
            try:
                marker.unlink(missing_ok=True)
            except OSError:
                pass


def _wait(root: Path, wt: Path, gate_id: str, started: str, begun: float, timeout: float | None, poll: float) -> tuple[int, dict]:
    def found():
        for line in read_log(wt):
            # a deploy step is repo-wide (its run log is in the git common dir): its answer counts from any worktree
            ours = gate_id.startswith("deploy-step:") or line.get("worktree") == str(wt)
            if line.get("gate") == gate_id and ours and str(line.get("at", "")) >= started:
                return line
        return None

    def pending():
        try:
            return any(g.id == gate_id for g in list_gates(model.load(root), wt))
        except Exception:
            return False

    def gone():
        """The gate left the list: an owner still at work holds the marker until its log line is written; GRACE then
        covers the chat route, whose owner script writes no marker. 0 with the line, 1 without, 3 on timeout."""
        while _answering(wt, gate_id):
            line = found()
            if line:
                return 0, _outcome(wt, gate_id, line)
            if timeout is not None and time.monotonic() - begun >= timeout:
                return 3, {}
            time.sleep(min(poll, 0.2))
        end = time.monotonic() + GRACE
        while True:
            line = found()  # an answer that landed since `started` still counts
            if line:
                return 0, _outcome(wt, gate_id, line)
            if time.monotonic() >= end:
                return 1, _outcome(wt, gate_id, None)
            time.sleep(0.05)

    if not pending():
        return gone()
    while True:
        line = found()
        if line:
            return 0, _outcome(wt, gate_id, line)
        if not pending():
            return gone()
        if timeout is not None and time.monotonic() - begun >= timeout:
            return 3, {}
        time.sleep(poll)


# --- the decision inbox: the reply a button gives, the worktrees, the lock file and the server ---

FORM = " (form)"
# (kind, button) -> (label in the reply, words required, the keywords for `answer`); a deploy step's reply is its words alone
BUTTONS = {
    ("approval", "approve"): ("Approve", False, {"choice": "approve"}),
    ("approval", "changes"): ("Request changes", True, {"choice": "changes"}),
    ("error-class", "confirm"): ("Confirm the class", False, {"choice": "confirm"}),
    ("error-class", "correct"): ("Correct it to {cls}", True, {"choice": "correct"}),
    ("error-class", "question"): ("Ask a question", True, {"choice": "question"}),  # AC-254.3, AC-254.6
    ("deploy-step", "send"): (None, True, {}),
    ("signoff", "pass"): ("Pass", False, {"result": "pass"}),
    ("signoff", "fail"): ("Fail", True, {"result": "fail"}),
}


class NeedsWords(Refused):
    """A button that needs the owner's words, or a class, sent without them: nothing ran."""


def build_reply(kind: str, button: str, words: str, cls: str | None = None) -> tuple[str, dict]:
    """The reply a button gives (`<label>`, or `<label>: <words>`, then ` (form)`; a deploy step's words alone, then
    ` (form)`) and the keyword arguments for `answer`. Words lose their leading and trailing whitespace only."""
    if (kind, button) not in BUTTONS:
        raise Refused(f"a {kind} gate has no button {button!r}")
    label, needs, kwargs = BUTTONS[(kind, button)]
    words = (words or "").strip()
    if needs and not words:
        raise NeedsWords(f"{(label or 'Send reply').format(cls='…')} needs your words")
    kwargs = dict(kwargs)
    if button == "correct":
        cls = (cls or "").strip()
        if not cls:
            raise NeedsWords("Correct it to… needs a class")
        if cls not in model.CLASSES or cls == "unclassified":
            raise Refused(f"class must be one of {', '.join(c for c in model.CLASSES if c != 'unclassified')}; got {cls!r}")
        label, kwargs["cls"] = label.format(cls=cls), cls
    if label is None:
        return words + FORM, kwargs
    return (f"{label}: {words}" if words else label) + FORM, kwargs


def _worktree_entries(repo_root: Path) -> list[dict]:
    """`git worktree list --porcelain`, one dict per entry (`worktree`, `branch`, `bare`, ...)."""
    entries, current = [], {}
    for line in _git(repo_root, "worktree", "list", "--porcelain").splitlines() + [""]:
        if not line:
            if current.get("worktree"):
                entries.append(current)
            current = {}
        else:
            key, _, value = line.partition(" ")
            current[key] = value
    return entries


def worktree_prds(repo_root: Path, prd_rel: str) -> list[dict]:
    """`{"path", "branch"}` for each worktree whose checkout holds `prd_rel`, the worktree of `repo_root` first."""
    here = str(Path(repo_root).resolve())
    out = []
    for wt in _worktree_entries(Path(repo_root)):
        root = Path(wt["worktree"]).resolve()
        if "bare" in wt or not (root / prd_rel / "prd.md").is_file():
            continue
        out.append({"path": str(root), "branch": wt.get("branch", "").removeprefix("refs/heads/") or "HEAD"})
    return sorted(out, key=lambda w: w["path"] != here)


INBOX_PREFIX = "prd-inbox-"
PING_TIMEOUT = 2.0


class PrdUnreadable(Exception):
    """The PRD could not be read this moment (it vanished or is being written): `make_inbox`'s own load failed with OSError."""


class InboxLive(Refused):
    """An inbox for this PRD is already serving."""

    def __init__(self, url: str, record: dict | None = None):
        super().__init__(f"an inbox is already serving at {url}")
        self.url, self.record = url, record  # the lock file's record: a standby takes over at its port with its token


def inbox_path(repo_root: Path, slug: str) -> Path:
    return common_dir(repo_root) / f"{INBOX_PREFIX}{slug}.json"


def inbox_url(record: dict) -> str:
    return f"http://127.0.0.1:{record['port']}/?token={record['token']}"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _ping(port: int, token: str) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never through a proxy
    url = f"http://127.0.0.1:{port}/ping?{urllib.parse.urlencode({'token': token})}"
    try:
        with opener.open(url, timeout=PING_TIMEOUT) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001 - refused, reset, 403, timeout: not live
        return False


def _drop(path: Path, raw: bytes) -> None:
    """Delete the lock file read as `raw`, never one written since."""
    try:
        if path.read_bytes() == raw:
            path.unlink()
    except OSError:
        pass


def live_inbox(repo_root: Path, slug: str) -> dict | None:
    """The lock file's record when its PID runs and `GET /ping` with its token answers 200 within 2 s; otherwise the
    file is deleted and None returned."""
    path = inbox_path(repo_root, slug)
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    try:
        rec = json.loads(raw)
    except ValueError:
        rec = None
    shaped = (isinstance(rec, dict) and all(isinstance(rec.get(k), int) and not isinstance(rec.get(k), bool) and rec[k] > 0
                                            for k in ("pid", "port")) and isinstance(rec.get("token"), str))
    if shaped and _alive(rec["pid"]) and _ping(rec["port"], rec["token"]):
        return rec
    _drop(path, raw)
    return None


def _claim(path: Path, record: dict, repo_root: Path, slug: str) -> None:
    """Write the lock file (mode 0600) only where none is; a live one refuses (InboxLive), a dead one is replaced."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{INBOX_PREFIX}", suffix=".tmp")  # mkstemp creates it 0600
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
        os.chmod(tmp, 0o600)
        for _ in range(3):
            try:
                os.link(tmp, path)  # atomic, and fails when the file exists: two inboxes never both start
                return
            except FileExistsError:
                live = live_inbox(repo_root, slug)
                if live:
                    raise InboxLive(inbox_url(live), live) from None
        raise Refused(f"cannot write {path.name}")
    finally:
        Path(tmp).unlink(missing_ok=True)


def _release(path: Path, token: str) -> None:
    try:
        rec = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(rec, dict) and rec.get("token") == token and rec.get("pid") == os.getpid():
            path.unlink()
    except (OSError, ValueError):
        pass


INBOX_PAGE = "gates/inbox.html"  # templates/gates/inbox.html in the plugin, .prd-toolkit/gates/inbox.html vendored
PLACEHOLDER = ('<!doctype html><html><head><meta charset="utf-8"><title>Decision inbox</title></head><body>'
               "<p>The inbox page is not installed. This inbox answers GET /gates and POST /answer.</p></body></html>")
DIFF_MAX = 200 * 1024


def inbox_page_path() -> tuple[Path, Path]:
    """The inbox page and the folder its include (`panel.html`) is read from: the plugin's templates, or the vendored copies."""
    from . import hooks

    if hooks.is_plugin():
        return hooks.PLUGIN_ROOT / "templates" / INBOX_PAGE, hooks.PLUGIN_ROOT / "templates" / "confirm"
    return hooks.SCRIPTS / INBOX_PAGE, hooks.SCRIPTS / "confirm"


def _inbox_page() -> str:
    page, include_dir = inbox_page_path()
    return formserver.assemble(page, include_dir) if page.is_file() else PLACEHOLDER


def _git_text(cwd: Path, *args: str) -> str:
    run = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return run.stdout if run.returncode == 0 else ""


def _diff_base(root: Path, verdict: dict | None = None) -> str | None:
    """The base the approval card diffs against, as review mode reads it: the verdict's `base` when it is a commit of
    this repository (any commit-ish), else the branch's upstream, else `main` when it is a commit, else None (HEAD)."""
    base = (verdict or {}).get("base")
    if isinstance(base, str) and base and _git_text(root, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}").strip():
        return base
    upstream = _git_text(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}").strip()
    if upstream:
        return upstream
    return "main" if _git_text(root, "rev-parse", "--verify", "--quiet", "main^{commit}").strip() else None


def _version_at(root: Path, rev: str, rel: str) -> str | None:
    text = _git_text(root, "show", f"{rev}:{rel}/prd.md")
    front = re.match(r"\A---\r?\n(.*?)\r?\n---", text, re.S)
    m = re.search(r"^version:[ \t]*(\S+)", front.group(1), re.M) if front else None
    return m.group(1).strip("'\"") if m else None


def _approval_card(prd: Prd, root: Path, rel: str) -> dict:
    verdict = json.loads((Path(prd.root) / REVIEW_FILE).read_text(encoding="utf-8"))
    out = {k: verdict.get(k) for k in ("restate", "touches", "bump", "impact", "dry_run")}
    base = _diff_base(root, verdict)
    diff = _git_text(root, "diff", "--no-color", "--no-ext-diff", base or "HEAD", "--", rel)
    raw = diff.encode("utf-8")
    out["diff_truncated"] = len(raw) > DIFF_MAX
    out["diff"] = raw[:DIFF_MAX].decode("utf-8", "ignore") if out["diff_truncated"] else diff
    out["version"] = {"from": _version_at(root, base or "HEAD", rel), "to": prd.frontmatter.get("version")}
    return out


def _plain(value):
    """A YAML value as plain JSON types."""
    return json.loads(json.dumps(value, default=str))


def card(gate: Gate, prd: Prd, root: Path, rel: str) -> dict:
    """The gate as `/gates` serves it: its fields, then what its kind's card shows (spec section 5)."""
    out = gate.to_dict()
    key = gate.id.split(":", 1)[1]
    if gate.kind == "approval":
        out.update(_approval_card(prd, root, rel))
    elif gate.kind == "error-class":
        e = prd.errors_ledger.get(key)
        out.update({"class": e.classification, "diagnosis": e.diagnosis, "explanation": e.explanation} if e else {})
    elif gate.kind == "deploy-step" and unreadable_run(gate):
        out.update({"run": unreadable_run(gate), "unreadable": True})
    elif gate.kind == "deploy-step":
        run_id, n = key.rsplit(":", 1)
        step = next((s for s in prd.operations.steps if str(s.number) == n), None)
        out.update({"run": run_id, "step": int(n), "env": step.env if step else None, "actor": step.actor if step else None,
                    "do": step.labels.get("Do", ("", 0))[0] if step else "", "check": step.labels.get("Check", ("", 0))[0] if step else ""})
    elif gate.kind == "signoff":
        tc = next((t for t in prd.test_cases if t.id == key), None)
        data = tc.data if tc else {}
        out.update({"tid": key, "owner": data.get("signoff"), "input": _plain(data.get("input")), "expect": _plain(data.get("expect"))})
    elif gate.kind == "adoption":
        out["area"] = key
    out["waiting"] = waiting(root, root, gate.id)
    return out


class _Inbox:
    """One inbox run: the PRD folder (`rel`) in every worktree of the repository of `root`."""

    def __init__(self, root: Path, rel: str, slug: str, page: str, started: str):
        self.root, self.rel, self.slug, self.page, self.started = root, rel, slug, page, started
        self.lock = threading.Lock()  # one answer at a time: a second answer to a gate re-lists after the first

    def worktree(self, raw) -> Path:
        if not isinstance(raw, str) or not raw:
            raise Bad(400, "name the worktree by its absolute path")
        known = {w["path"] for w in worktree_prds(self.root, self.rel)}
        path = Path(raw)
        resolved = str(path.resolve()) if path.is_absolute() else None
        if resolved not in known:
            raise Bad(404, f"{raw} is not a worktree of this repository holding {self.rel}")
        return Path(resolved)

    def load(self, wt: Path) -> Prd:
        try:
            return model.load(wt / self.rel)
        except model.NotAPrd as e:
            raise Bad(404, str(e)) from None

    def listing(self) -> dict:
        groups, shown, held = [], set(), set()
        listed = worktree_prds(self.root, self.rel)
        forget_loaded({(Path(wt["path"]) / self.rel).resolve() for wt in listed})
        for wt in listed:
            root = Path(wt["path"])
            try:
                prd = load_unchanged(root / self.rel)  # E-068: an unchanged worktree's PRD is not loaded again
                found = [card(g, prd, root, self.rel) for g in list_gates(prd, root)
                         if not (g.kind == "deploy-step" and g.id in shown)  # a run is repo-wide: once, in the first group
                         and not inboxcards.held_earlier(g, prd, held)]  # an entry's card: in the first group holding it
            except (model.NotAPrd, OSError) as e:
                if isinstance(e, model.NotAPrd) or not (root / self.rel).is_dir():
                    continue  # the worktree was removed while listing
                groups.append({**wt, "gates": [], "error": f"{type(e).__name__}: {e}"})
                continue
            except Exception as e:  # noqa: BLE001 - a broken gate shows as the group's error, never as no gates
                groups.append({**wt, "gates": [], "error": f"{type(e).__name__}: {e}"})
                continue
            shown |= {g["id"] for g in found if g["kind"] == "deploy-step"}
            held |= inboxcards.entries(prd)  # a group listed with an error holds no entry
            groups.append({**wt, "gates": found})
        answers = [ln for ln in read_log(self.root) if ln.get("prd") == self.slug and str(ln.get("at", "")) >= self.started]
        return {"prd": self.slug, "started": self.started, "worktrees": groups, "answers": answers}

    def answer(self, body: dict) -> tuple[int, dict]:
        wt = self.worktree(body.get("worktree"))
        gate_id, question, words, cls = body.get("gate"), body.get("question"), body.get("words"), body.get("class")
        button = body.get("choice") if body.get("choice") is not None else body.get("result")
        if not isinstance(gate_id, str) or not gate_id:
            raise Bad(400, "name the gate")
        if not isinstance(question, str):
            raise Bad(400, "send the question the page showed; the inbox never answers without it")
        if words is not None and not isinstance(words, str) or cls is not None and not isinstance(cls, str):
            raise Bad(400, "words and class must be text")
        if not isinstance(button, str):
            raise Bad(400, "send the button: choice")
        with self.lock:
            prd = self.load(wt)
            gate = next((g for g in list_gates(prd, wt) if g.id == gate_id), None)
            if gate is None:
                raise Bad(409, f"refused: {REFUSED_CHANGED}")
            if gate.kind == "adoption":
                raise Bad(400, "an adoption gate is answered item by item, then Done, through /adoption/<area>/")
            try:
                reply, kwargs = build_reply(gate.kind, button, words or "", cls)
                done = answer(prd, wt, gate_id, reply, question=question, by="form", **kwargs)
            except Refused as e:
                raise Bad(409 if str(e) == REFUSED_CHANGED else 400, f"refused: {e}") from None
        code = done["result"]["exit"]
        if code == 0:
            return 200, done
        why = "\n".join(done["result"].get("stderr") or done["result"]["stdout"]) or f"the owner exited {code}"
        # an owner's refusal is 400, its tool error 500; prd_deploy.py confirm refuses with exit 2 (a usage error), not 1
        first = ((done["result"].get("stderr") or [""])[0])
        refused = code == 1 or (gate.kind == "deploy-step" and code == 2 and not first.startswith("prd_deploy: internal error:"))
        return (400 if refused else 500), {**done, "error": why}

    def done(self, prd: Prd, wt: Path, area: str, routes, body: dict) -> tuple[int, dict]:
        """Done goes through `answer` (`prd_confirm.py done`) with the question the page showed, so it is logged;
        400 without the question, 409 while an item is open or changed or when the question changed."""
        question = body.get("question")
        if not isinstance(question, str):
            raise Bad(400, "send the question the page showed; the inbox never answers without it")
        still = routes.items()["open"]
        if still:
            return 409, {"open": still}
        with self.lock:
            try:
                done = answer(prd, wt, f"adoption:{area}", "Done (form)", choice="done", question=question, by="form")
            except Refused as e:
                return 409, {"open": [], "error": f"refused: {e}"}
        if done["result"]["exit"] != 0:
            return 409, {"open": confirm.AdoptionRoutes(self.load(wt), area, wt).items()["open"], **done}
        return 200, {"open": []}


def _inbox_handler(state: _Inbox) -> type[formserver.Handler]:
    adoption = re.compile(r"^/adoption/([^/]+)/(items|answer|undo|done)$")

    class Handler(formserver.Handler):
        def route(self, method: str, route: str, query: dict) -> None:
            body = self.body_json() if method == "POST" else None
            m = adoption.match(route)
            if method == "GET" and route == "/":
                self.send_page(state.page)
            elif method == "GET" and route == "/gates":
                self.send_json(200, state.listing())
            elif method == "POST" and route == "/answer":
                self.send_json(*state.answer(body))
            elif m and (method == "GET") == (m.group(2) == "items"):
                self.adoption(m.group(1), m.group(2), query, body)
            else:
                raise Bad(404, "no such request")

        def adoption(self, area: str, verb: str, query: dict, body: dict | None) -> None:
            raw = (query.get("wt") or [None])[0]
            if raw is None:
                raise Bad(400, "name the worktree: ?wt=<absolute path>")
            wt = state.worktree(raw)
            prd = state.load(wt)
            if not any(r.area == area for r in prd.adoption or []):
                raise Bad(404, f"area {area} is not in adoption.md")
            if not confirm.answers_path(wt, area).is_file():
                raise Bad(404, f"area {area} has no answers file in {wt}")
            try:
                routes = confirm.AdoptionRoutes(prd, area, wt)
                if verb == "items":
                    self.send_json(200, routes.items())
                elif verb == "done":
                    self.send_json(*state.done(prd, wt, area, routes, body))
                else:
                    self.send_json(200, routes.answer(body) if verb == "answer" else routes.undo(body))
            except confirm.Refused as e:
                self.send_json(confirm.refused_status(e), confirm.refused_body(e))

    return Handler


def make_inbox(prd_dir: Path, port: int = 0, idle_minutes: float = 120, token: str | None = None):
    """The inbox server for the PRD at `prd_dir`, bound to 127.0.0.1, and its token (`token` when given, so a standby
    takes over at the same URL; else a new one). Writes the lock file (mode 0600),
    which is deleted when `formserver.run` returns or the server is closed. Raises InboxLive, OSError (port in use),
    formserver.PageError, model.NotAPrd, PrdUnreadable (the PRD's load failed with OSError; a bind failure stays OSError)."""
    class InboxServer(formserver.Server):
        lock_path: Path | None = None

        def serve_forever(self, poll_interval: float = 0.5) -> None:
            try:
                super().serve_forever(poll_interval)
            finally:
                self.release()

        def server_close(self) -> None:
            self.release()
            super().server_close()

        def release(self) -> None:
            if self.lock_path is not None:
                _release(self.lock_path, self.token)
                self.lock_path = None

    try:
        prd = model.load(Path(prd_dir))
    except OSError as e:
        raise PrdUnreadable(str(e)) from e
    root = model.repo_root(prd.root).resolve()
    rel = prd.root.resolve().relative_to(root).as_posix()
    slug = prd.frontmatter.get("prd", prd.root.name)
    live = live_inbox(root, slug)
    if live:
        raise InboxLive(inbox_url(live), live)
    state = _Inbox(root, rel, slug, _inbox_page(), _now())
    token = token or secrets.token_urlsafe(24)
    server = InboxServer(("127.0.0.1", port), _inbox_handler(state), token, idle_minutes, state)
    path = inbox_path(root, slug)
    try:
        _claim(path, {"pid": os.getpid(), "port": server.server_address[1], "token": token, "started": state.started, "prd": slug}, root, slug)
    except BaseException:
        server.server_close()
        raise
    server.lock_path = path
    return server, token
