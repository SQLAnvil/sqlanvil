"""errors.md writes: each command replaces or inserts lines inside one entry and nothing else in the file moves."""
import re
import subprocess
import tempfile
from datetime import date
from pathlib import Path

from . import deploy, trace
from .buildcheck import _resolve, _show
from .cardcontext import ENTRY_URL, well_formed
from .deploy import LEDGER_PLACEHOLDER, Refused
from .markdown import tables
from .model import CLASSES, ErrorEntry, Prd, _errors_ledger, load

MAX_EVIDENCE = 20
ORDER = ("Detected", "Classification", "Confirmed", "Touches", "Evidence", "Diagnosis", "Resolution", "Recurrence of")
_FIELD = re.compile(r"^(" + "|".join(ORDER) + r"):")
_VERSION = re.compile(r"\d+\.\d+\.\d+")
_COMMIT = re.compile(r"[0-9a-f]{7,40}")
_TID = re.compile(r"T-\d{3}\.\d+")
_RUN = re.compile(r"[^\s,]+")


def _one(text: str) -> str:
    """Line breaks and runs of spaces collapse to single spaces."""
    return " ".join(text.split())


_OPENS_FENCE = re.compile(r"^\s*(```|~~~)")
_FENCE_FIX = "would open a code fence; drop it or put text before it"


def _no_fence(flag: str, value: str) -> None:
    """A value whose first characters open a code fence would end the ledger's parse; refuse it."""
    if _OPENS_FENCE.match(value):
        raise Refused([f"{flag} {_FENCE_FIX}"])


def _path(prd: Prd) -> Path:
    return prd.root / "errors.md"


def _read(prd: Prd) -> str:
    p = _path(prd)
    return p.read_text(encoding="utf-8") if p.is_file() else ""


def _entry(text: str, eid: str) -> ErrorEntry:
    e = _errors_ledger(text).get(eid)
    if e is None:
        raise Refused([f"{eid} is not an entry"])
    return e


def _set(text: str, eid: str, name: str, value: str) -> str:
    """Replace the entry's `name:` line, or insert it after the last earlier field in the canonical order."""
    e = _entry(text, eid)
    lines = text.split("\n")
    at = ORDER.index(name)
    last = e.line  # 1-based line to insert after; the heading when no earlier field exists
    n = e.line + 1
    while n <= e.end:
        m = _FIELD.match(lines[n - 1])
        if m:
            end = n
            if m.group(1) == "Evidence":
                while end < e.end and lines[end].startswith("  "):
                    end += 1
            if m.group(1) == name:
                lines[n - 1:end] = [f"{name}: {value}"]
                return "\n".join(lines)
            if ORDER.index(m.group(1)) < at:
                last = end
            n = end
        n += 1
    lines.insert(last, f"{name}: {value}")
    return "\n".join(lines)


def _write(prd: Prd, text: str) -> None:
    _path(prd).write_text(text, encoding="utf-8")


def _check_class(cls: str) -> None:
    if cls not in CLASSES or cls == "unclassified":
        raise ValueError(f"class must be one of {', '.join(c for c in CLASSES if c != 'unclassified')}; got {cls!r}")


def parse_touches(raw: str) -> list[str]:
    """`--touches` as a list: [] for none given, ["-"] for "none", else the IDs; "-" with IDs is refused."""
    items = [t.strip() for t in raw.split(",") if t.strip()]
    if "-" in items and items != ["-"]:
        raise Refused(["Touches: - cannot be combined with IDs"])
    return items


def new(prd: Prd, title: str, source: str, touches: list[str], evidence: list[str], today: date, url: str | None = None) -> str:
    title, source = _one(title), _one(source)
    if not title or not source:
        raise ValueError("a title and a source are required")
    _no_fence("--title", title)
    if url is not None and not well_formed(url):  # FR-064: `-` is no address for new
        raise Refused([ENTRY_URL])
    reasons = []
    known = {b.id for b in prd.blocks}
    unknown = [t for t in touches if t != "-" and t not in known]
    if unknown:
        reasons.append(f"Touches: {', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} not defined in the PRD")
    evidence = [ln.rstrip() for ln in evidence]
    while evidence and not evidence[-1]:
        evidence.pop()
    if len(evidence) > MAX_EVIDENCE:
        reasons.append(f"Evidence: is {len(evidence)} lines; at most {MAX_EVIDENCE}")
    reasons += [f"Evidence: line {n} {_FENCE_FIX}" for n, ln in enumerate(evidence, 1) if _OPENS_FENCE.match(ln)]
    if reasons:
        raise Refused(reasons)
    text = _read(prd)
    ledger = _errors_ledger(text)
    eid = "E-%03d" % (max((int(i[2:]) for i in ledger), default=0) + 1)
    block = [f"### {eid} {title}", f"Detected: {today.isoformat()}, {source}", "Classification: unclassified"]
    if touches:
        block.append("Touches: " + ", ".join(touches))
    if url is not None:
        block.append(f"URL: {url}")  # after Touches:, or after Classification: with no Touches:
    if evidence:
        block.append("Evidence: " + evidence[0])
        block += ["  " + ln for ln in evidence[1:]]
    block += ["Diagnosis: -", "Resolution: -", "Recurrence of: -"]
    entry = "\n".join(block)
    lines = text.split("\n")
    if not ledger and LEDGER_PLACEHOLDER in (ln.strip() for ln in lines):
        out = "\n".join(entry if ln.strip() == LEDGER_PLACEHOLDER else ln for ln in lines)
    elif text.strip():
        out = text.rstrip("\n") + "\n\n" + entry + "\n"
    else:
        out = "# Error ledger\n\n" + entry + "\n"
    _write(prd, out)
    return eid


def set_url(prd: Prd, eid: str, address: str) -> None:
    """FR-064: write the entry's `URL:` line, or remove it for `-`; every other line of errors.md stays as it was."""
    if address != "-" and not well_formed(address):
        raise Refused([ENTRY_URL])
    text = _read(prd)
    e = _entry(text, eid)
    lines = text.split("\n")
    if address == "-":
        if not e.url_line:
            return  # no URL: line: errors.md is left byte for byte as it was
        del lines[e.url_line - 1]
    elif e.url_line:
        lines[e.url_line - 1] = f"URL: {address}"
    else:
        after = max(e.detected_line, e.classification_line, e.confirmed_line, e.touches_line) or e.line
        lines.insert(after, f"URL: {address}")
    _write(prd, "\n".join(lines))


def propose(prd: Prd, eid: str, cls: str, diagnosis: str, recurrence: str | None, touches: list[str] | None = None) -> None:
    _check_class(cls)
    diagnosis = _one(diagnosis)
    if not diagnosis:
        raise ValueError("a diagnosis is required")
    _no_fence("--diagnosis", diagnosis)
    text = _read(prd)
    e = _entry(text, eid)
    if e.state in ("confirmed", "resolved"):
        raise Refused([f"{eid} is {e.state}; its class is settled" if e.state == "confirmed" else f"{eid} is resolved"])
    if recurrence is not None and recurrence not in _errors_ledger(text):
        raise Refused([f"Recurrence of: {recurrence} is not an entry"])
    unknown = [t for t in touches or [] if t != "-" and t not in {b.id for b in prd.blocks}]
    if unknown:
        raise Refused([f"Touches: {', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} not defined in the PRD"])
    text = _set(text, eid, "Classification", cls)
    if touches:
        text = _set(text, eid, "Touches", ", ".join(touches))
    text = _set(text, eid, "Diagnosis", diagnosis)
    if recurrence is not None:
        text = _set(text, eid, "Recurrence of", recurrence)
    _write(prd, text)


def confirm(prd: Prd, eid: str, reply: str, today: date, cls: str | None = None) -> None:
    reply = _one(reply)
    if not reply:
        raise ValueError("the reply is empty")
    _no_fence("--reply", reply)
    if cls is not None:
        _check_class(cls)
    text = _read(prd)
    e = _entry(text, eid)
    if e.state == "resolved":
        raise Refused([f"{eid} is resolved"])
    if e.state == "unclassified":
        raise Refused([f"{eid} is unclassified; propose a class first"])
    if e.state == "confirmed":
        raise Refused([f"{eid} is already confirmed"])
    if cls is not None:
        text = _set(text, eid, "Classification", cls)
    _write(prd, _set(text, eid, "Confirmed", f'{today.isoformat()}, "{reply}"'))


def resolve(prd: Prd, eid: str, *, t: str | None, level: str | None, version: str, commit: str | None,
            run: str | None, not_a_defect: str | None) -> None:
    if not_a_defect is not None:
        if any((t, level, commit, run)) or version:
            raise ValueError("--not-a-defect stands alone")
        why = _one(not_a_defect)
        if not why:
            raise ValueError("say why it is not a defect")
        _no_fence("--not-a-defect", why)
        value = f"not a defect: {why}"
    else:
        if not _VERSION.fullmatch(version or ""):
            raise ValueError(f"version must be X.Y.Z; got {version!r}")
        if t is not None and not _TID.fullmatch(t):
            raise ValueError(f"not a T-id: {t!r}")
        if run is not None:
            if commit is not None or not _RUN.fullmatch(run):
                raise ValueError("--run takes a run id and no commit")
            value = f"{t or '-'}, PRD {version}, run {run}"
        else:
            if not t or not level or not commit:
                raise ValueError("a fix needs a T-id, its level and a commit")
            if not _COMMIT.fullmatch(commit):
                raise ValueError(f"commit must be 7 to 40 lowercase hex digits; got {commit!r}")
            value = f"{t} [{level}], PRD {version}, fixed in {commit}"
    text = _read(prd)
    e = _entry(text, eid)
    if e.state == "resolved":
        raise Refused([f"{eid} is already resolved"])
    if e.state != "confirmed":
        raise Refused([f"{eid} is not confirmed"])
    _write(prd, _set(text, eid, "Resolution", value))


def entry_lines(prd: Prd, eid: str) -> list[str]:
    text = _read(prd)
    e = _entry(text, eid)
    out = text.split("\n")[e.line - 1:e.end]
    while out and not out[-1].strip():
        out.pop()
    return out


def summary(e: ErrorEntry) -> str:
    """`confirmed code bug`, or just `unclassified`: the state, then the class when it adds something."""
    cls = e.classification
    return e.state if cls in ("", e.state) else f"{e.state} {cls}"


def list_lines(prd: Prd, open_only: bool) -> list[str]:
    return [f"{e.id} {summary(e)} {', '.join(t for t, _ in e.touches) or '-'} {e.title}".rstrip()
            for e in _errors_ledger(_read(prd)).values() if e.open or not open_only]


_FIX = re.compile(r"(T-\d{3}\.\d+) \[[^\]\s][^\]]*\], PRD (\d+\.\d+\.\d+), fixed in ([0-9a-f]{7,40})")
_ENV = re.compile(r"(T-\d{3}\.\d+|-), PRD (\d+\.\d+\.\d+), run (\S+)")
_NOT_A_DEFECT = re.compile(r"not a defect: \S.*")
_RANGE = re.compile(r"^([^.\s][^\s]*?)\.\.([^.\s][^\s]*)$")
_STEP = re.compile(r"\bstep\s+(\d+)\b")
_TOKEN = re.compile(r"[0-9A-Za-z][0-9A-Za-z._-]*")


def _ver(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def _structure(prev: dict[str, ErrorEntry], cur: dict[str, ErrorEntry]) -> list[tuple[str, str]]:
    """What one write did to the ledger besides adding entries and filling in lines: (E-id, finding)."""
    out: list[tuple[str, str]] = []
    added = [e for i, e in cur.items() if i not in prev]
    for eid, e in prev.items():
        if eid not in cur:
            twin = next((a for a in added if a.title == e.title), None)
            out.append((eid, f"renumbered to {twin.id}" if twin else "deleted"))
    common = [i for i in cur if i in prev]
    before = {i: n for n, i in enumerate(prev)}
    for n, x in enumerate(common):
        later = next((y for y in common[n + 1:] if before[y] < before[x]), None)
        if later:
            out.append((x, f"moved before {later}"))
    for eid in common:
        a, b = prev[eid], cur[eid]
        if a.detected != b.detected:
            out.append((eid, "Detected: changed"))
        if a.confirmed_raw is not None:
            if a.classification != b.classification:
                out.append((eid, "Classification: changed after Confirmed:"))
            if a.confirmed_raw != b.confirmed_raw:
                out.append((eid, "Confirmed: changed"))
    return out


def _resolution(prd: Prd, repo_root: Path, head: str, e: ErrorEntry, cited: dict, tagged: dict, versions: set[str],
                prefix: str) -> list[str]:
    """Findings on a resolution added in the range, judged against the PRD at head."""
    from . import errorreplay  # FR-081: the red run is the error-replay area's

    text = e.resolution
    fix, env, nad = _FIX.fullmatch(text), _ENV.fullmatch(text), _NOT_A_DEFECT.fullmatch(text)
    if errorreplay.RED_RUN.fullmatch(text):
        return errorreplay.check_red_run(prd, repo_root, head, e, prefix)
    if not (fix or env or nad):
        return ["resolution is not one of the four forms"]
    out: list[str] = []
    if nad:
        return out
    tid, version = (fix or env).group(1), (fix or env).group(2)
    if tid != "-":
        cases = {tc.id: tc for tc in prd.test_cases}
        if tid not in cases:
            out.append(f"{tid} has no test case")
        else:
            if tid not in cited:
                out.append(f"{tid} is cited by no test")
            if cases[tid].data.get("known-failing") == e.id or (tid, e.id) in tagged:
                out.append(f"{tid} is still known-failing on {e.id}")
    head_version = prd.frontmatter.get("version", "")
    if re.fullmatch(r"\d+\.\d+\.\d+", head_version) and _ver(version) > _ver(head_version):
        out.append(f"PRD {version} is above the PRD version {head_version}")
    elif version not in versions:
        out.append(f"PRD {version} has no changelog row")
    if fix:
        commit = fix.group(3)
        ok = subprocess.run(["git", "merge-base", "--is-ancestor", commit + "^{commit}", head], cwd=repo_root,
                            capture_output=True, timeout=60).returncode == 0
        if not ok:
            out.append(f"commit {commit} is not an ancestor of HEAD")
    else:
        out += _run_finished(prd, repo_root, e, env.group(3))
    return out


_RUN_NAME = re.compile(r"\d{8}T\d{6}Z-[0-9A-Za-z._-]*[0-9A-Za-z_-]")


def _failed_env(prd: Prd, recs: list[dict], step: int | None) -> str | None:
    """The environment a run failed on: the step `Detected:` names, else the run's failing (or unfinished) step."""
    if step is None:
        rec = next((r for r in recs if r.get("kind") == "step" and r.get("result") == "fail"), None) \
            or next(iter(deploy.unfinished_starts(recs)), None)
        step = rec.get("step") if rec else None
    return next((s.env for s in prd.operations.steps if s.number == step), None)


def _run_finished(prd: Prd, repo_root: Path, e: ErrorEntry, run_id: str) -> list[str]:
    """A `run R` resolution: R has a log, and it shows the environment of the entry's failed run finished (or, when
    `Detected:` names no run, every environment R's own plan covered)."""
    logs = deploy.log_dir(repo_root)
    try:
        recs = deploy.read_log(repo_root, run_id)
    except (OSError, ValueError):
        return [f"run {run_id} has no log in {logs}"]
    finished = deploy.finished_envs(recs, prd)
    step = _STEP.search(e.detected)
    failed = next((m.group(0) for m in _TOKEN.finditer(e.detected) if _RUN_NAME.fullmatch(m.group(0).rstrip("."))), None)
    if failed is None:
        header = next((r for r in recs if r.get("kind") == "header"), {})
        try:
            plan = deploy.plan_steps(prd, header.get("until"))
        except ValueError:
            plan = list(prd.operations.steps)
        envs = list(dict.fromkeys(s.env for s in plan if s.env))
    else:
        failed = failed.rstrip(".")
        try:
            frecs = deploy.read_log(repo_root, failed)
        except (OSError, ValueError):
            return [f"the failed run {failed} named in Detected: has no log in {logs}"]
        env = _failed_env(prd, frecs, int(step.group(1)) if step else None)
        envs = [env] if env else []
    return [f"run {run_id} did not finish {env}" for env in envs if env not in finished]


def _changelog_versions(prd: Prd) -> set[str]:
    for s in prd.sections:
        if s.title.strip().lower() == "changelog":
            ts = tables(s.body)
            return {r.cells[0].strip() for r in ts[0].rows} if ts else set()
    return set()


def check_findings(prd: Prd, repo_root: Path, rng: str) -> list[str]:
    """Findings for every change to errors.md in `base..head`, each `errors.md: E-nnn: <finding>`.

    BadRange for a bad range. Structure is judged write by write, the code-commit gate against errors.md at each
    commit, a resolution added in the range against the PRD at head."""
    m = _RANGE.match(rng)
    if not m or "..." in rng:
        raise trace.BadRange(f"bad range {rng}: expected <base>..<head>")
    base, head = _resolve(repo_root, rng, m.group(1)), _resolve(repo_root, rng, m.group(2))
    prefix = deploy.prd_rel(prd, repo_root)
    rel = "errors.md" if prefix == "." else f"{prefix}/errors.md"
    commits = [ln.split() for ln in deploy._git(repo_root, "rev-list", "--parents", "--reverse", "--end-of-options", f"{base}..{head}").splitlines()]
    shas = [c[0] for c in commits]

    cache: dict[str, dict[str, ErrorEntry]] = {}

    def ledger_at(rev: str) -> dict[str, ErrorEntry]:
        text = _show(repo_root, rev, rel)
        if text not in cache:
            cache[text] = _errors_ledger(text)
        return cache[text]

    out: list[tuple[str, str]] = []
    for sha, *parents in commits:
        cur = ledger_at(sha)
        for parent in parents:  # a merge is compared with each parent
            prev = ledger_at(parent)
            if cur is not prev:
                out += _structure(prev, cur)

    is_code = trace.outside_prd(prd, repo_root)
    for sha in shas:
        files = [f for f in deploy._git(repo_root, "diff-tree", "-m", "--no-commit-id", "--name-only", "-r", "-z", "--root", sha).split("\0") if f]
        if not any(is_code(f) for f in files):
            continue
        body = deploy._git(repo_root, "log", "-1", "--format=%B", sha)
        cited = [r.strip() for m_ in trace._REFS.finditer(body) for r in m_.group(1).split(",")]
        for eid in dict.fromkeys(r for r in cited if trace._ERR_ID.fullmatch(r)):
            e = ledger_at(sha).get(eid)
            if e is None or e.confirmed_raw is None:
                out.append((eid, f"commit {sha[:8]} changes code and cites {eid}, which was not confirmed at that commit"))

    start, end = ledger_at(base), ledger_at(head)
    new = [e for i, e in end.items() if not e.open and (i not in start or start[i].resolution != e.resolution)]
    if new:
        with tempfile.TemporaryDirectory(prefix="prd-error-check-") as tmp:
            try:
                h_prd = load(deploy._tree(repo_root, head, prefix, Path(tmp)))
            except Exception as ex:
                raise trace.BadRange(f"cannot load the PRD at {head[:7]}: {ex}") from None
            cited, tagged, versions = trace.citations(prd, repo_root), trace.tagged_citations(prd, repo_root), _changelog_versions(h_prd)
            for e in new:
                if e.confirmed_raw is None:
                    out.append((e.id, "resolved without Confirmed:"))
                out += [(e.id, f) for f in _resolution(h_prd, repo_root, head, e, cited, tagged, versions, prefix)]
    return list(dict.fromkeys(f"errors.md: {eid}: {f}" for eid, f in out))
