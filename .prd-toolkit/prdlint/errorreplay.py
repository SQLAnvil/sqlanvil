"""prd error replay: run an errors.md entry's test on the commit before its fix, where it must fail, and on the fix,
where it must pass, each run in a git clone of its own that is removed after it (FR-075 to FR-081)."""
import functools
import os
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import deploy, errors, trace
from .deploy import Refused
from .model import ErrorEntry, Prd, _errors_ledger, gate_of

KIND = "error-replay"
DEFAULT_TIMEOUT = 600
RED_RUN = re.compile(r"fixed in ([0-9a-f]{7,40}), red run ([^\s-]\S*) \[([^\]\s]+)\]")
_FIX_LEVEL = re.compile(r"T-\d{3}\.\d+ \[([^\]]*)\]")
_SHELL_WORDS = ("cd", "env", "sh", "bash", "zsh", "eval", "exec")
_WHOLE = re.compile(r"[0-9]+")
_NO_COMMIT, _MANY_COMMITS, _NO_PARENT = "names no commit", "names more than one commit", "has no parent"


@dataclass
class Run:
    commit: str  # the full SHA of the commit whose tree ran
    when: str  # "before" (on <sha>^) or "after" (on <sha>)
    argument: str
    exit: int | None  # None when it timed out or cannot start
    seconds: float
    timed_out: bool
    cannot_start: bool = False  # the operating system could not start its program (AC-078.14)

    @property
    def passed(self) -> bool:
        return not self.timed_out and not self.cannot_start and self.exit == 0

    @property
    def failed(self) -> bool:
        return not self.timed_out and not self.cannot_start and self.exit != 0


@dataclass
class Replay:
    entry: str
    outcome: str  # "holds", "skipped" or "findings"
    subject: str | None = None
    reason: str | None = None
    findings: list[str] = field(default_factory=list)
    runs: list[Run] = field(default_factory=list)
    sha: str = ""  # the <sha> text of the Resolution line, for the line that says the proof holds

    def lines(self) -> list[str]:
        """What the text form prints on stdout (AC-078.3, AC-078.5, AC-076.2, AC-077.2, AC-078.8)."""
        if self.outcome == "holds":
            return [f"{self.entry}: {self.subject} fails on {self.sha}^ and passes on {self.sha}"]
        if self.outcome == "skipped":
            return [f"skipped: {self.entry}: {self.reason}"]
        return list(self.findings)

    def payload(self) -> dict:
        """The --json document after `interface` and `kind` (AC-078.11)."""
        return {"entry": self.entry, "outcome": self.outcome, "subject": self.subject, "reason": self.reason,
                "findings": list(self.findings),
                "runs": [{"commit": r.commit, "when": r.when, "argument": r.argument, "exit": r.exit,
                          "seconds": r.seconds, "timed_out": r.timed_out} for r in self.runs]}


def simple_command(cell: str) -> list[str] | None:
    """The words of a cell that is one simple command in backticks (FR-075), else None."""
    c = cell.strip()
    if len(c) < 2 or not (c.startswith("`") and c.endswith("`")) or c.count("`") != 2:
        return None
    text = c[1:-1]
    if any(ch in text for ch in "${~;|") or "&&" in text:
        return None
    try:
        words = shlex.split(text)
    except ValueError:
        return None
    if not words or words[0] in _SHELL_WORDS or "=" in words[0]:
        return None
    return words


def one_test_command(prd: Prd, level: str) -> list[str] | None:
    """A level's One test command (AC-075.1); None for an empty cell, a malformed one or no One test column."""
    return simple_command(prd.testing.one_tests.get(level, ""))


def malformed_one_test(cell: str) -> bool:
    """A One test cell lint reports (AC-075.2): not empty, and not one simple command in backticks."""
    return bool(cell.strip()) and simple_command(cell) is None


def _timeout(prd: Prd, level: str, given: int | None) -> int:
    """The --timeout value, else the level's Timeout cell when it holds a whole number of at least 1, else 600 s."""
    if given is not None:
        return given
    cell = prd.testing.timeouts.get(level, "")
    return int(cell) if _WHOLE.fullmatch(cell) and int(cell) >= 1 else DEFAULT_TIMEOUT


@functools.cache
def _local_env_vars() -> frozenset[str]:
    """The variables `git rev-parse --local-env-vars` lists: those that point git at one repository."""
    out = subprocess.run(["git", "rev-parse", "--local-env-vars"], capture_output=True, timeout=600, check=True).stdout
    return frozenset(out.decode().split())


def _git_env() -> dict[str, str]:
    """The command's environment less the variables that point git at a repository (FR-079)."""
    local = _local_env_vars()
    return {**{k: v for k, v in os.environ.items() if k not in local}, "GIT_LITERAL_PATHSPECS": "1"}


def _git(repo_root: Path, *args: str, check: bool = True, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(["git", *args], cwd=repo_root, input=stdin, capture_output=True, timeout=600,
                          env=_git_env())
    if check and proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines() or ["no output"]
        raise RuntimeError(f"git {' '.join(args)} failed: {err[0]}")
    return proc


def _commit_of(repo_root: Path, sha: str) -> tuple[str | None, str | None]:
    """(the one commit `sha` names, None), or (None, why not): no commit, more than one, or no parent."""
    names = _git(repo_root, "rev-parse", f"--disambiguate={sha}", check=False).stdout.decode().split()
    types = _git(repo_root, "cat-file", "--batch-check", stdin="".join(n + "\n" for n in names).encode(),
                 check=False).stdout.decode().splitlines() if names else []
    commits = [ln.split()[0] for ln in types if len(ln.split()) == 3 and ln.split()[1] == "commit"]
    if not commits:
        return None, _NO_COMMIT
    if len(commits) > 1:
        return None, _MANY_COMMITS
    if _git(repo_root, "rev-parse", "--verify", "--quiet", f"{commits[0]}^1", check=False).returncode != 0:
        return None, _NO_PARENT
    return commits[0], None


def _parent(repo_root: Path, commit: str) -> str:
    return _git(repo_root, "rev-parse", "--verify", f"{commit}^1").stdout.decode().strip()


def _blobs(repo_root: Path, shas: list[str]) -> dict[str, bytes]:
    """The content of each blob, read with one `git cat-file --batch`."""
    want = list(dict.fromkeys(shas))
    if not want:
        return {}
    out = _git(repo_root, "cat-file", "--batch", stdin="".join(s + "\n" for s in want).encode()).stdout
    got, at = {}, 0
    for s in want:
        nl = out.index(b"\n", at)
        head = out[at:nl].split()
        at = nl + 1
        if len(head) == 3:
            size = int(head[2])
            got[s] = out[at:at + size]
            at += size + 1
    return got


def _resolving_commit(prd: Prd, repo_root: Path, eid: str, resolution: str) -> str:
    """The first commit, in `git rev-list --topo-order --reverse HEAD` order, whose errors.md holds the entry with this
    Resolution line; HEAD when none does."""
    prefix = deploy.prd_rel(prd, repo_root)
    rel = "errors.md" if prefix == "." else f"{prefix}/errors.md"
    revs = _git(repo_root, "rev-list", "--topo-order", "--reverse", "HEAD").stdout.decode().split()
    checks = _git(repo_root, "cat-file", "--batch-check", stdin="".join(f"{r}:{rel}\n" for r in revs).encode(),
                  check=False).stdout.decode().splitlines() if revs else []
    blob_of = {}
    for rev, ln in zip(revs, checks):
        parts = ln.split()
        if len(parts) == 3 and parts[1] == "blob":
            blob_of[rev] = parts[0]
    texts = _blobs(repo_root, list(blob_of.values()))
    holds: dict[str, bool] = {}
    for rev in revs:
        blob = blob_of.get(rev)
        if blob is None:
            continue
        if blob not in holds:
            e = _errors_ledger(texts.get(blob, b"").decode("utf-8", "replace")).get(eid)
            holds[blob] = e is not None and e.resolution == resolution
        if holds[blob]:
            return rev
    return _git(repo_root, "rev-parse", "HEAD").stdout.decode().strip()


def replay_roots(prd: Prd) -> list[str]:
    """The backticked paths of `Test roots:` in testing.md, less white space and trailing `/`; else `tests`."""
    roots = [r.strip().rstrip("/") for r in (prd.testing.harness.test_roots or [])]
    roots = [r for r in roots if r]
    return roots or ["tests"]


def _under(path: str, roots: list[str]) -> bool:
    return any(path == r or path.startswith(r + "/") for r in roots)


def _cited_files(repo_root: Path, commit: str, roots: list[str], tid: str) -> list[str]:
    """Each file under a test root in `commit`'s tree whose text cites `tid`, sorted by path."""
    listing = _git(repo_root, "ls-tree", "-r", "-z", "--full-tree", commit).stdout.decode("utf-8", "surrogateescape")
    files = {}
    for item in filter(None, listing.split("\0")):
        meta, path = item.split("\t", 1)
        mode, kind, blob = meta.split()
        if kind == "blob" and mode in ("100644", "100755") and _under(path, roots):
            files[path] = blob
    texts = _blobs(repo_root, list(files.values()))
    return sorted(p for p, b in files.items() if tid in trace.cited_tids(texts.get(b, b"").decode("utf-8", "replace")))


class _Clones:
    """Clones under one new folder in the system temporary folder; each is removed after its run, the folder at the end.
    A clone is `git clone --shared --no-checkout` of the repository, then a checkout of the commit with HEAD detached:
    nothing is written in the repository's git folder and no worktree is added to it (FR-079, E-035)."""

    def __init__(self, repo_root: Path):
        common = _git(repo_root, "rev-parse", "--git-common-dir").stdout.decode().strip()
        self.source = str((repo_root / common).resolve())
        self.folder = Path(tempfile.mkdtemp(prefix="prd-error-replay-", dir=os.environ.get("TMPDIR") or None))
        self.n = 0

    def add(self, commit: str) -> Path:
        self.n += 1
        path = self.folder / f"run-{self.n}"
        try:
            _git(self.folder, "clone", "--shared", "--no-checkout", "--quiet", "--", self.source, str(path))
            _git(path, "checkout", "--quiet", "--detach", commit)
        except BaseException:
            self.drop(path)
            raise
        return path

    def drop(self, path: Path) -> None:
        """Removing a clone is removing its folder."""
        shutil.rmtree(path, ignore_errors=True)

    def close(self) -> None:
        shutil.rmtree(self.folder, ignore_errors=True)


def _replace_roots(wt: Path, resolving: str, roots: list[str]) -> None:
    """Every test root of the clone replaced, whole, by that root of the resolving commit's tree."""
    for root in roots:
        _git(wt, "rm", "-r", "-q", "--ignore-unmatch", "--", root)
        p = wt / root
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists() or p.is_symlink():
            p.unlink()
        if _git(wt, "cat-file", "-e", f"{resolving}:{root}", check=False).returncode == 0:
            _git(wt, "checkout", resolving, "--", root)


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _execute(argv: list[str], cwd: Path, timeout: int) -> tuple[int | None, float, bool, bool]:
    """One run, without a shell, in a process group of its own: (exit or None, seconds, timed out, cannot start)."""
    start = time.monotonic()
    try:
        proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:  # AC-078.14: the operating system cannot start the program
        return None, round(time.monotonic() - start, 3), False, True
    try:
        code: int | None = proc.wait(timeout=timeout)
        timed_out = False
    except subprocess.TimeoutExpired:
        code, timed_out = None, True
    except BaseException:
        _kill(proc)
        proc.wait()
        raise
    _kill(proc)  # what the run left behind in its group goes with it
    if timed_out:
        proc.wait()
    return code, round(time.monotonic() - start, 3), timed_out, False


def _quiet_cleanup(fn) -> None:
    """Clean up with SIGINT held off, so a second interrupt cannot leave a clone behind."""
    try:
        old = signal.signal(signal.SIGINT, signal.SIG_IGN)
    except ValueError:  # not the main thread
        old = None
    try:
        fn()
    finally:
        if old is not None:
            signal.signal(signal.SIGINT, old)


def _runs(repo_root: Path, rep: Replay, sha: str, commit: str, command: list[str], arguments: list[str],
          timeout: int, resolving: str | None, roots: list[str]) -> None:
    """Every run on <sha>^, then every run on <sha>, each in its own clone; then the findings (AC-078.8)."""
    before = _parent(repo_root, commit)
    trees = _Clones(repo_root)
    try:
        for when, rev in (("before", before), ("after", commit)):
            for arg in arguments:
                wt = trees.add(rev)
                try:
                    if resolving is not None:
                        _replace_roots(wt, resolving, roots)
                    code, seconds, timed_out, cannot_start = _execute(command + [arg], wt, timeout)
                finally:
                    _quiet_cleanup(lambda: trees.drop(wt))
                rep.runs.append(Run(rev, when, arg, code, seconds, timed_out, cannot_start))
    finally:
        _quiet_cleanup(trees.close)
    first = [r for r in rep.runs if r.when == "before"]
    then = [r for r in rep.runs if r.when == "after"]
    out = []
    for r in first:
        if r.timed_out:
            out.append(f"{rep.entry}: timed out after {timeout} s on {sha}^")
        elif r.cannot_start:
            out.append(f"{rep.entry}: {command[0]} cannot start on {sha}^")
    if all(r.passed for r in first):
        out.append(f"{rep.entry}: {rep.subject} passes on {sha}^; {sha} did not turn it green")
    for r in then:
        if r.timed_out:
            out.append(f"{rep.entry}: timed out after {timeout} s on {sha}")
        elif r.cannot_start:
            out.append(f"{rep.entry}: {command[0]} cannot start on {sha}")
        elif r.failed:
            out.append(f"{rep.entry}: {rep.subject} fails on {sha}: {r.argument}")
    rep.findings = out
    rep.outcome = "findings" if out else "holds"


def _replay_line(prd: Prd, repo_root: Path, eid: str, line: str, timeout: int | None) -> Replay:
    """Replay a resolved entry's Resolution line: the checks of AC-078.7 in order, then the runs."""
    fix, red = errors._FIX.fullmatch(line), RED_RUN.fullmatch(line)
    if errors._ENV.fullmatch(line):
        return Replay(eid, "skipped", reason="resolved by an environment run")
    if errors._NOT_A_DEFECT.fullmatch(line):
        return Replay(eid, "skipped", reason="resolved as not a defect")
    if not (fix or red):
        return Replay(eid, "findings", findings=[f"{eid}: resolution is not one of the four forms"])
    if fix:
        subject, level, sha = fix.group(1), _FIX_LEVEL.match(line).group(1), fix.group(3)
    else:
        sha, subject, level = red.group(1), red.group(2), red.group(3)
    rep = Replay(eid, "findings", subject=subject, sha=sha)
    if level not in prd.testing.levels:
        rep.findings = [f"{eid}: {level} is not a level of testing.md"]
        return rep
    if gate_of(prd, level) == "deploy":
        rep.outcome, rep.reason = "skipped", f"{level} is a deploy-gate level"
        return rep
    command = one_test_command(prd, level)
    if command is None:
        rep.outcome, rep.reason = "skipped", f"{level} has no One test command"
        return rep
    commit, why = _commit_of(repo_root, sha)
    if commit is None:
        rep.findings = [f"{eid}: {sha} {why}"]
        return rep
    resolving, roots, arguments = None, [], [subject]
    if fix:
        roots = replay_roots(prd)
        resolving = _resolving_commit(prd, repo_root, eid, line)
        arguments = _cited_files(repo_root, resolving, roots, subject)
        if not arguments:
            rep.findings = [f"{eid}: {subject} is cited by no test in {resolving[:7]}"]
            return rep
    _runs(repo_root, rep, sha, commit, command, arguments, _timeout(prd, level, timeout), resolving, roots)
    return rep


def replay(prd: Prd, repo_root: Path, eid: str, timeout: int | None = None) -> Replay:
    """`prd error replay <prd_dir> <E-id>` (FR-076 to FR-079). Refused when <E-id> is not an entry (AC-078.1)."""
    e = prd.errors_ledger.get(eid)
    if e is None:
        raise Refused([f"{eid} is not an entry"])
    if e.open:
        return Replay(eid, "findings", findings=[f"{eid} is not resolved"])
    return _replay_line(prd, repo_root, eid, e.resolution, timeout)


def red_run_line(commit: str, test_id: str, level: str) -> str:
    return f"fixed in {commit}, red run {test_id} [{level}]"


def replay_red_run(prd: Prd, repo_root: Path, eid: str, commit: str, test_id: str, level: str,
                   timeout: int | None = None) -> Replay:
    """The replay (FR-077) of the line `resolve --red-run` would write, before it is written."""
    return _replay_line(prd, repo_root, eid, red_run_line(commit, test_id, level), timeout)


def covering_area(prd: Prd, prefix: str, path: str) -> str | None:
    """The first adopted row whose Boundary glob matches `path`; none for a path in the PRD folder or `.prd-toolkit/`."""
    if path == ".prd-toolkit" or path.startswith(".prd-toolkit/"):
        return None
    if prefix == "." or path == prefix or path.startswith(prefix + "/"):
        return None
    for row in prd.adoption or []:
        if row.state == "adopted" and any(trace.glob_re(g).match(path) for g in row.boundary):
            return row.area
    return None


def changed_paths(repo_root: Path, commit: str) -> list[str]:
    """`git diff --no-renames --name-only <sha>^ <sha>`, from the repository root, in its order."""
    out = _git(repo_root, "diff", "--no-renames", "--name-only", "-z", f"{commit}^", commit).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def _first_covered(prd: Prd, repo_root: Path, prefix: str, sha: str) -> tuple[str, str] | None:
    commit, _why = _commit_of(repo_root, sha)
    if commit is None:
        return None
    for path in changed_paths(repo_root, commit):
        area = covering_area(prd, prefix, path)
        if area is not None:
            return path, area
    return None


def red_run_refusals(prd: Prd, repo_root: Path, entry: str, commit: str, test_id: str, level: str) -> list[str]:
    """Why `resolve --red-run` refuses, in AC-080.10's order after the flags; [] when it may write the line."""
    e = prd.errors_ledger.get(entry)
    if e is None:
        return [f"{entry} is not an entry"]
    if e.state == "resolved":
        return [f"{entry} is already resolved"]
    if e.state != "confirmed":
        return [f"{entry} is not confirmed"]
    if e.classification != "code bug":
        return [f"{entry} is classed {e.classification}; a red run resolves a code bug only"]
    if level not in prd.testing.levels:
        return [f"{level} is not a level of testing.md"]
    if gate_of(prd, level) == "deploy":
        return [f"{level} is a deploy-gate level"]
    if one_test_command(prd, level) is None:
        return [f"{level} has no One test command; add the One test column to testing.md Levels through /prd-toolkit:prd-change"]
    if re.search(r"\s", test_id) or test_id.startswith("-"):
        return ["the test id must hold no white space and must not start with -"]
    if prd.adoption is None:
        return ["the PRD has no adoption map, so every path is covered; resolve with a regression T-id"]
    covered = _first_covered(prd, repo_root, deploy.prd_rel(prd, repo_root), commit)
    if covered:
        return [f"{commit} changes {covered[0]}, which area {covered[1]} covers; resolve with a regression T-id"]
    rep = replay_red_run(prd, repo_root, entry, commit, test_id, level)
    return [] if rep.outcome == "holds" else list(rep.findings)


def write_red_run(prd: Prd, eid: str, commit: str, test_id: str, level: str) -> None:
    """Write `Resolution: fixed in <sha>, red run <test id> [<level>]` into the entry, every other line as it was."""
    text = errors._read(prd)
    errors._write(prd, errors._set(text, eid, "Resolution", red_run_line(commit, test_id, level)))


def check_red_run(prd: Prd, repo_root: Path, head: str, entry: ErrorEntry, prefix: str) -> list[str]:
    """`prd error check` on a red run added in its range, against the PRD at head, with no run (AC-081.1)."""
    m = RED_RUN.fullmatch(entry.resolution)
    sha, level = m.group(1), m.group(3)
    out = []
    if _git(repo_root, "merge-base", "--is-ancestor", sha + "^{commit}", head, check=False).returncode != 0:
        out.append(f"commit {sha} is not an ancestor of HEAD")
    if prd.adoption is None:
        out.append("the PRD has no adoption map, so every path is covered")
    else:
        covered = _first_covered(prd, repo_root, prefix, sha)
        if covered:
            out.append(f"commit {sha} changes {covered[0]}, which area {covered[1]} covers")
    if level not in prd.testing.levels:
        out.append(f"{level} is not a level of testing.md")
    return out
