"""The build's two mechanical checks: what the builder touched, and what the tester reported."""
import os
import shutil
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

from .yamlload import _Loader

from .model import Prd
from .testerpaths import roots_of, tester_tids
from .trace import BadRange, citations

RESULT = re.compile(r"^(T-\d{3}\.\d+): (pass|fail: .+|known-failing E-\d+)$")
_LINE_TID = re.compile(r"^(T-\d{3}\.\d+)\b")


TIMEOUT = 120  # seconds any one subprocess of these checks may run; a test shortens it


class ToolError(Exception):
    """A git or vendor run the refresh check depends on failed."""


def _run(cmd: list[str], what: str | None = None, **kw) -> subprocess.CompletedProcess:
    """subprocess.run with the module timeout; a run that exceeds it is a ToolError, not an internal error."""
    try:
        return subprocess.run(cmd, capture_output=True, timeout=TIMEOUT, **kw)
    except subprocess.TimeoutExpired:
        name = what or " ".join(["git", next((a for a in cmd[1:] if not a.startswith("-")), "")]).strip()
        raise ToolError(f"{name} timed out after {TIMEOUT:g} s") from None


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return _run(["git", *args], cwd=root, encoding="utf-8", errors="replace")


def _show(root: Path, rev: str, path: str) -> str:
    if _git(root, "cat-file", "-e", f"{rev}:{path}").returncode != 0:
        return ""  # the path does not exist at that end (added or deleted): fine
    p = _git(root, "show", f"{rev}:{path}")
    if p.returncode != 0:
        raise RuntimeError(f"git show {rev}:{path} failed: {(p.stderr.strip().splitlines() or ['?'])[0]}")
    return p.stdout


_RANGE = re.compile(r"^([^.\s][^\s]*?)\.\.([^.\s][^\s]*)$")


def _resolve(root: Path, rng: str, rev: str) -> str:
    p = _git(root, "rev-parse", "--verify", "--end-of-options", f"{rev}^{{commit}}")
    if p.returncode != 0:
        raise BadRange(f"bad range {rng}: {rev} is not a commit")
    return p.stdout.strip()


MANIFEST = ".claude-plugin/plugin.json"


def _first_line(text: str) -> str:
    return (text.strip().splitlines() or ["failed"])[0]


def plugin_dir(repo_root: Path, rev: str) -> str | None:
    """The one directory at `rev` holding the prd-toolkit plugin (its plugin.json and scripts/prd_hooks.py); None for zero or several."""
    p = _git(repo_root, "ls-tree", "-r", "--name-only", rev)
    if p.returncode != 0:
        raise ToolError(f"git ls-tree {rev}: {_first_line(p.stderr)}")
    names = set(p.stdout.split("\n"))
    found = []
    for name in sorted(names):
        if name != MANIFEST and not name.endswith("/" + MANIFEST):
            continue
        d = name[: -len(MANIFEST)].rstrip("/")
        if (f"{d}/scripts/prd_hooks.py" if d else "scripts/prd_hooks.py") not in names:
            continue
        try:
            data = json.loads(_show(repo_root, rev, name))
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("name") == "prd-toolkit":
            found.append(d or ".")
    return found[0] if len(found) == 1 else None


def refresh_differences(repo_root: Path, head: str, plugin: str, prd_rel: str) -> list[str]:
    """Sorted .prd-toolkit/ paths whose bytes at `head` differ from what `prd_hooks.py vendor` writes from the plugin held at `head`,
    including paths missing at `head` or present there and not written by vendor; [] when the copy is exact."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / "work"
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(tmp) / "index")}  # a throwaway index: the checkout touches no real one
        for cmd in (["read-tree", head], ["checkout-index", "-a", f"--prefix={tmp_path}/"]):
            p = _run(["git", *cmd], cwd=repo_root, env=env)
            if p.returncode != 0:
                raise ToolError(f"git {cmd[0]} {head}: {_first_line(p.stderr.decode('utf-8', 'replace'))}")
        shutil.rmtree(tmp_path / ".prd-toolkit", ignore_errors=True)  # the expected tree is what a fresh vendor writes
        init = _git(tmp_path, "init", "-q")
        if init.returncode != 0:
            raise ToolError(f"git init: {_first_line(init.stderr)}")
        script = tmp_path / plugin / "scripts/prd_hooks.py"
        run = _run([sys.executable, str(script), "vendor", prd_rel], "vendor", cwd=tmp_path, encoding="utf-8", errors="replace")
        if run.returncode != 0:
            raise ToolError(f"vendor at {head[:12]}: {_first_line(run.stderr or run.stdout)}")
        expected: dict[str, tuple[bytes, bool]] = {}
        for f in (tmp_path / ".prd-toolkit").rglob("*"):
            if f.is_file() and "__pycache__" not in f.parts:
                expected[f.relative_to(tmp_path).as_posix()] = (f.read_bytes(), bool(f.stat().st_mode & 0o100))
    p = _git(repo_root, "ls-tree", "-r", "-z", head, "--", ".prd-toolkit")
    if p.returncode != 0:
        raise ToolError(f"git ls-tree {head}: {_first_line(p.stderr)}")
    actual: dict[str, tuple[bytes, bool]] = {}
    for entry in filter(None, p.stdout.split("\0")):
        meta, name = entry.split("\t", 1)
        blob = _run(["git", "show", f"{head}:{name}"], cwd=repo_root)
        if blob.returncode != 0:
            raise ToolError(f"git show {head}:{name}: {_first_line(blob.stderr.decode('utf-8', 'replace'))}")
        actual[name] = (blob.stdout, meta.split()[0] == "100755")
    return sorted(n for n in expected.keys() | actual.keys() if expected.get(n) != actual.get(n))


def diff_findings(prd: Prd, repo_root: Path, rng: str) -> list[str]:
    m = _RANGE.match(rng)
    if not m or "..." in rng:
        raise BadRange(f"bad range {rng}: expected <base>..<head>")
    base, head = _resolve(repo_root, rng, m.group(1)), _resolve(repo_root, rng, m.group(2))
    proc = _git(repo_root, "diff", "--name-status", "-M", "-z", "--end-of-options", f"{base}..{head}")
    if proc.returncode != 0:
        raise BadRange(f"bad range {rng}: {(proc.stderr.strip().splitlines() or ['git diff failed'])[0]}")
    fields = proc.stdout.split("\0")
    paths: list[str] = []
    i = 0
    while i < len(fields) and fields[i]:
        status = fields[i]
        n = 2 if status[0] in "RC" else 1
        paths += fields[i + 1:i + 1 + n]
        i += 1 + n
    prefix = Path(os.path.relpath(prd.root.resolve(), repo_root.resolve())).as_posix()
    levels = {tc.id: tc.data.get("level") for tc in prd.test_cases}
    roots = roots_of(prd)
    findings: list[str] = []
    vendored: list[str] = []
    for path in dict.fromkeys(paths):
        if prefix == "." or path == prefix or path.startswith(prefix + "/"):
            findings.append(f"{path}: the builder may not edit the PRD folder")
            continue
        if path == ".prd-toolkit" or path.startswith(".prd-toolkit/"):
            vendored.append(path)
            continue
        # only a path under a test root is a tester's test; its text is read at the base, then at the head
        non_unit = tester_tids(path, (_show(repo_root, rev, path) for rev in (base, head)), levels, roots)
        if non_unit:
            findings.append(f"{path} cites {', '.join(non_unit)}, a tester's test: the builder may not edit it")
    if vendored:
        plugin = plugin_dir(repo_root, head)
        if plugin is not None:
            findings += [f"{p}: differs from the plugin; refresh it with prd_hooks.py vendor"
                         for p in refresh_differences(repo_root, head, plugin, prefix)]
        else:
            findings += [f"{p}: the builder may not edit the vendored .prd-toolkit/ copy" for p in vendored]
    return findings


_SOURCE_LINE = re.compile(r"^\s*(?:SOURCES\b:?\s*)?(?:[-*]\s+)?([A-Za-z][\w]*-\d+(?:\.\d+)?):\s*(.+?):(\d+)\s*$")
_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def sources_findings(repo_root: Path, rng: str, text: str) -> list[str]:
    """Hold a builder's SOURCES lines (<ID>: <path>:<line>) to the files and hunks the round changed."""
    m = _RANGE.match(rng)
    if not m or "..." in rng:
        raise BadRange(f"bad range {rng}: expected <base>..<head>")
    base, head = _resolve(repo_root, rng, m.group(1)), _resolve(repo_root, rng, m.group(2))
    proc = _git(repo_root, "diff", "--name-only", "--no-renames", "-z", "--end-of-options", f"{base}..{head}")
    if proc.returncode != 0:
        raise BadRange(f"bad range {rng}: {(proc.stderr.strip().splitlines() or ['git diff failed'])[0]}")
    changed = {p for p in proc.stdout.split("\0") if p}
    hunks: dict[str, list[tuple[int, int]]] = {}

    def hunks_of(path: str) -> list[tuple[int, int]]:
        if path not in hunks:
            d = _git(repo_root, "diff", "-U0", "--no-color", "--no-renames", base, head, "--", path)
            if d.returncode != 0:
                raise RuntimeError(f"git diff {path} failed: {(d.stderr.strip().splitlines() or ['?'])[0]}")
            found = []
            for line in d.stdout.splitlines():
                h = _HUNK.match(line)
                if h:
                    start, count = int(h.group(1)), int(h.group(2) or 1)
                    # a hunk that only deletes counts at its deletion point: line start or start + 1
                    found.append((start, start + count - 1) if count else (start, start + 1))
            hunks[path] = found
        return hunks[path]

    findings: list[str] = []
    for n, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        s = _SOURCE_LINE.match(raw)
        if not s:
            findings.append(f"sources: line {n} is not '<ID>: <path>:<line>'")
            continue
        sid, path, line = s.group(1), s.group(2), int(s.group(3))
        if path not in changed:
            findings.append(f"sources: {sid}: {path} is not changed in {rng}")
            continue
        spans = hunks_of(path)
        if not any(a <= line <= b for a, b in spans):
            listed = ", ".join(f"{a}-{b}" for a, b in spans)
            findings.append(f"sources: {sid}: {path}:{line} is outside the round's changes (hunks {listed})")
    return findings


_HEADING = re.compile(r"^#*\s*(?:\d+\.\s*)?(?:\*\*)?RESULTS\b")
_RESULT_LINE = re.compile(r"^(?:[-*]\s+)?(T-\d{3}\.\d+)\b")


def results_findings(report: str, tids: list[str]) -> list[str]:
    """The block starts at the first line beginning with a RESULTS heading; its result lines are the
    contiguous run of T-id lines after it (blank lines allowed before the first); the first line after
    a result line that is blank or not a result line ends it, and what follows is notes."""
    lines = [line.strip() for line in report.split("\n")]
    start = next((n for n, line in enumerate(lines) if _HEADING.match(line)), None)
    findings: list[str] = []
    counts: dict[str, int] = {}
    for line in lines[start + 1:] if start is not None else []:
        if not line and not counts:
            continue  # blank lines before the first result line are skipped; after it, a blank line ends the run
        m = _RESULT_LINE.match(line)
        if not m:
            break
        tid = m.group(1)
        counts[tid] = counts.get(tid, 0) + 1
        body = re.sub(r"^[-*]\s+", "", line)
        if tid not in tids:
            findings.append(f"{tid} was not dispatched")
        elif not RESULT.match(body):
            findings.append(f"{tid}: not one of pass, fail: <reason>, known-failing E-nnn")
    for tid, n in counts.items():
        if n > 1 and tid in tids:
            findings.append(f"{tid}: more than one RESULTS line")
    for tid in tids:
        if tid not in counts:
            findings.append(f"{tid} has no RESULTS line")
    return findings


def _last_commit(root: Path, path: str) -> tuple[int, str, str] | None:
    """(commit time, full sha, short sha) of the last commit that changed `path`, None when it has none."""
    p = _git(root, "--literal-pathspecs", "log", "-1", "--format=%ct %H %h", "--", path)
    if p.returncode != 0:
        raise RuntimeError(f"git log {path} failed: {(p.stderr.strip().splitlines() or ['?'])[0]}")
    parts = p.stdout.split()
    return (int(parts[0]), parts[1], parts[2]) if len(parts) == 3 else None


def _case_entries(root: Path, rev: str | None, prd_rel: str, tid: str) -> object:
    """The parsed entry for `tid` across every test-case file of the PRD at `rev` (None: the working tree); a
    missing entry is the sentinel `_ABSENT`."""
    if rev is None:
        names = sorted(p.relative_to(root).as_posix() for p in (root / prd_rel / "test-cases").glob("*.yaml") if p.is_file())
    else:
        p = _git(root, "ls-tree", "-z", rev, "--", f"{prd_rel}/test-cases/")
        if p.returncode != 0:
            raise RuntimeError(f"git ls-tree {rev} failed: {(p.stderr.strip().splitlines() or ['?'])[0]}")
        # direct children only (no -r), regular files only (blob), names unquoted (-z): the set the working-tree glob reads
        entries = [e.split("\t", 1) for e in p.stdout.split("\0") if e]
        names = [name for meta, name in entries if meta.split()[1] == "blob" and name.endswith(".yaml")]
    for name in names:
        text = (root / name).read_text(encoding="utf-8") if rev is None else _show(root, rev, name)
        data = yaml.load(text, Loader=_Loader)  # the loader's reader: the first value of a repeated key wins
        if isinstance(data, dict) and tid in data:
            return data[tid]
    return _ABSENT


_ABSENT = object()


def stale_findings(prd: Prd, repo_root: Path, tids: list[str]) -> list[str]:
    """One line per T-id of `tids` whose test case differs, as parsed YAML, between the commit that last changed
    its test and the working tree. A T-id with no test, or any of whose citing files has a git status entry, is
    never stale. A citing file with no commit (a git-ignored one has no status entry) is skipped, and the other
    committed citing files are still judged; of two committed citing files the newer by commit time is judged."""
    cites = citations(prd, repo_root)
    prd_rel = Path(os.path.relpath(prd.root.resolve(), repo_root.resolve())).as_posix()
    out: list[str] = []
    for tid in tids:
        best: tuple[int, str, str, str] | None = None
        files = list(dict.fromkeys(f for f, _ in cites.get(tid, [])))
        if files:
            st = _git(repo_root, "--literal-pathspecs", "status", "--porcelain", "--", *files)
            if st.returncode != 0:
                raise RuntimeError(f"git status failed: {(st.stderr.strip().splitlines() or ['?'])[0]}")
            if st.stdout.strip():
                continue  # a citing test with a status entry is being written now
        for path in files:
            last = _last_commit(repo_root, path)
            if last and (best is None or last[0] > best[0]):
                best = (last[0], last[1], last[2], path)
        if best is None:
            continue
        _, full, short, path = best
        now = _case_entries(repo_root, None, prd_rel, tid)
        if now is _ABSENT:
            continue  # a removed case is a PRD change, not a stale test
        if _case_entries(repo_root, full, prd_rel, tid) != now:
            out.append(f"stale {tid} {path}: its test case changed after the test (last changed in {short})")
    return out
