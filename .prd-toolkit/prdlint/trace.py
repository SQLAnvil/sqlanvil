"""Trace rules: does the code side of a PRD keep up with it? Not lint rules; they are not in registry.RULES."""
import re
import subprocess
from collections.abc import Callable, Iterator
from pathlib import Path

from .findings import Finding
from .model import ADOPTION_FILE, Prd, _adoption, gate_of

TRACE_RULES = ("t-implemented", "test-cites-live", "commit-refs", "status-current", "known-failing-tags")

CITE = re.compile(r"@prd\s+(T-\d{3}\.\d+)\b")
TAG = re.compile(r"@prd\s+(T-\d{3}\.\d+)\s+known-failing:?\s+(E-\d+)\b")
_REFS = re.compile(r"^Refs:[ \t]*(.*)$", re.MULTILINE)
_CS_LINE = re.compile(r"^Change-set:(.*)$", re.MULTILINE)
_CS_VALUE = re.compile(r"^Change-set:[ \t]*([a-z][a-z0-9-]*/CS-\d{3})[ \t]*$", re.MULTILINE)
_REQ_ID = re.compile(r"(?:UJ|FR|NFR)-\d+")
_ERR_ID = re.compile(r"E-\d+")
UNCONFIRMED = "{} is not confirmed; a commit that changes code may cite it only after prd_error.py confirm"
REFS_NONE = "none (no behaviour change)"
_SHA = re.compile(r"[0-9a-f]{40}")
DEFAULT_TEST_ROOTS = ["tests"]
DRY_RUN_PREFIX = ".prd-dry-run-"


class BadRange(Exception):
    """The --range value is not a revision range git accepts."""


def _rel(prd: Prd, path: Path) -> str:
    """`path` relative to the PRD folder, so the CLI's usual prefix turns it into a cwd-relative path."""
    import os

    return Path(os.path.relpath(path, prd.root)).as_posix()


def _roots(prd: Prd, repo_root: Path) -> list[Path]:
    roots = prd.testing.harness.test_roots or DEFAULT_TEST_ROOTS
    return [(repo_root / r.strip().rstrip("/")) for r in roots]


def _line_matches(text: str, rx: re.Pattern) -> Iterator[tuple[int, re.Match]]:
    """Every match of `rx` in `text` as (1-based line, match), each line read on its own: the one rule every citation scan shares."""
    for n, line in enumerate(text.split("\n"), 1):
        for m in rx.finditer(line):
            yield n, m


def _scan(prd: Prd, repo_root: Path, rx: re.Pattern) -> list[tuple[tuple[str, ...], str, int]]:
    """Every match of `rx` under the test roots as (groups, file relative to repo_root, line)."""
    out: list[tuple[tuple[str, ...], str, int]] = []
    seen: set[Path] = set()
    for root in _roots(prd, repo_root):
        files = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else []
        for p in files:
            if p in seen or "__pycache__" in p.parts or ".git" in p.parts:
                continue
            if any(part.startswith(DRY_RUN_PREFIX) for part in p.relative_to(root).parts):
                continue  # a dry run's throwaway tests, left behind: they prove nothing
            seen.add(p)
            try:
                text = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            rel = p.relative_to(repo_root).as_posix() if p.is_relative_to(repo_root) else p.as_posix()
            for n, m in _line_matches(text, rx):
                out.append((m.groups(), rel, n))
    return out


def cited_tids(text: str) -> list[str]:
    """The T-ids cited in `text`, read line by line as `_scan` reads a file: `@prd` and its T-id share a line."""
    return [m.group(1) for _, m in _line_matches(text, CITE)]


def citations(prd: Prd, repo_root: Path) -> dict[str, list[tuple[str, int]]]:
    """T-id -> [(file relative to repo_root, line)] for every `@prd T-nnn.n` under the test roots."""
    out: dict[str, list[tuple[str, int]]] = {}
    for (tid,), rel, n in _scan(prd, repo_root, CITE):
        out.setdefault(tid, []).append((rel, n))
    return out


def tagged_citations(prd: Prd, repo_root: Path) -> dict[tuple[str, str], list[tuple[str, int]]]:
    """(T-id, E-id) -> [(file relative to repo_root, line)] for every `@prd T-nnn.n known-failing E-nnn`."""
    out: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for (tid, eid), rel, n in _scan(prd, repo_root, TAG):
        out.setdefault((tid, eid), []).append((rel, n))
    return out


def area(file: str) -> str:
    return "nfr" if file == "nfr.md" else Path(file).stem


def _in_scope(prd: Prd) -> set[str] | None:
    """Areas trace covers; None means every area (no adoption map: a new project)."""
    if prd.adoption is None:
        return None
    return {r.area for r in prd.adoption if r.state == "adopted"}


def glob_re(glob: str) -> re.Pattern:
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile(out + r"\Z")


def in_boundary(prd: Prd, repo_root: Path) -> Callable[[str], bool]:
    """Predicate on a repo-relative path: is it under the commit rule?

    A project with no adoption map covers every path outside the PRD folder and `.prd-toolkit/`;
    otherwise a path is covered when an `adopted` row's Boundary glob matches it.
    """
    if prd.adoption is None:
        try:
            skip = prd.root.resolve().relative_to(repo_root.resolve()).as_posix()
        except ValueError:
            skip = None

        def inside_new(path: str) -> bool:
            if path == ".prd-toolkit" or path.startswith(".prd-toolkit/"):
                return False
            return not (skip and (path == skip or path.startswith(skip + "/")))

        return inside_new
    rxs = [glob_re(g) for r in prd.adoption if r.state == "adopted" for g in r.boundary]
    return lambda path: any(rx.match(path) for rx in rxs)


def outside_prd(prd: Prd, repo_root: Path) -> Callable[[str], bool]:
    """Predicate on a repo-relative path: is it outside the PRD folder, so a commit touching it changes code?"""
    try:
        skip = prd.root.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        skip = None
    return lambda path: not (skip is not None and (skip == "." or path == skip or path.startswith(skip + "/")))


def refs_problems(prd: Prd, message: str, code_commit: bool = False) -> list[str]:
    """What is wrong with the `Refs:` trailer(s) of a commit message; [] when it passes.

    A commit that changes code (`code_commit`) may cite an entry only once it holds `Confirmed:`."""
    values = [m.group(1).strip() for m in _REFS.finditer(message)]
    values = [v for v in values if v]
    if not values:
        return ["no `Refs:` trailer (`Refs: FR-001`, or `Refs: none (no behaviour change)`)"]
    blocks = {b.id: b for b in prd.blocks}
    problems: list[str] = []
    for value in values:
        if value == REFS_NONE:
            continue
        for ref in (x.strip() for x in value.split(",")):
            if not ref:
                continue
            if ref == "none":
                problems.append(f"`none` alone is not accepted; write `Refs: {REFS_NONE}`")
            elif _REQ_ID.fullmatch(ref):
                b = blocks.get(ref)
                if b is None:
                    problems.append(f"{ref} is not defined in the PRD")
                elif b.status == "removed":
                    problems.append(f"{ref} is removed")
            elif _ERR_ID.fullmatch(ref):
                entry = prd.errors_ledger.get(ref)
                if entry is None:
                    problems.append(f"{ref} is not defined in the PRD")
                elif code_commit and entry.confirmed_raw is None:
                    problems.append(UNCONFIRMED.format(ref))
            else:
                problems.append(f"`{ref}` is not a PRD ID; give other keys their own trailer")
    return problems


def unconfirmed_refs(prd: Prd, message: str) -> list[str]:
    """The `Refs:` problems a code commit outside the Boundary still has: each cited entry not yet confirmed."""
    out = []
    for m in _REFS.finditer(message):
        for ref in (x.strip() for x in m.group(1).split(",")):
            entry = prd.errors_ledger.get(ref) if _ERR_ID.fullmatch(ref) else None
            if entry is not None and entry.confirmed_raw is None and UNCONFIRMED.format(ref) not in out:
                out.append(UNCONFIRMED.format(ref))
    return out


def changeset_problems(prd: Prd, message: str) -> list[str]:
    """What is wrong with the `Change-set:` trailer(s) of a commit message; [] when it passes.

    A value must be `<prd>/CS-nnn`; one naming this PRD must have a record under changes/ (another PRD's is not checked here)."""
    own = prd.frontmatter.get("prd")
    problems: list[str] = []
    for m in _CS_LINE.finditer(message):
        v = _CS_VALUE.fullmatch(m.group(0).rstrip("\r"))
        if v is None:
            problems.append(f"`Change-set: {m.group(1).strip()}` must be {own}/CS-nnn")
            continue
        slug, _, cs = v.group(1).partition("/")
        if slug == own and cs not in prd.change_sets:
            problems.append(f"Change-set: {v.group(1)} has no record in changes/")
    return problems


def _commits(repo_root: Path, rng: str) -> list[tuple[str, str, list[str]]]:
    proc = subprocess.run(
        ["git", "-c", "core.quotePath=false", "-c", "log.showSignature=false", "log", "--format=%H%x00%B%x00", "--name-only", "--end-of-options", rng],
        cwd=repo_root, capture_output=True, encoding="utf-8", errors="replace", timeout=60,
    )
    if proc.returncode != 0:
        raise BadRange(f"bad --range {rng}: {(proc.stderr.strip().splitlines() or ['git log failed'])[0]}")
    parts = proc.stdout.split("\x00")
    commits, sha, i = [], None, 0
    while i + 1 < len(parts):
        if sha is None:
            sha = parts[i].strip()
            i += 1
        body, tail = parts[i], parts[i + 1]
        lines = tail.split("\n")
        nxt = None
        if lines and _SHA.fullmatch(lines[-1].strip()) and i + 2 < len(parts):
            nxt, lines = lines[-1].strip(), lines[:-1]
        commits.append((sha, body, [x.strip() for x in lines if x.strip()]))
        sha, i = nxt, i + 2
        if sha is None:
            break
    return commits


def _git_out(repo_root: Path, *args: str) -> str | None:
    proc = subprocess.run(["git", "-c", "core.quotePath=false", *args], cwd=repo_root, capture_output=True,
                          encoding="utf-8", errors="replace", timeout=60)
    return proc.stdout if proc.returncode == 0 else None


def _boundary_at(prd: Prd, repo_root: Path) -> Callable[[str], Callable[[str], bool] | None]:
    """For a commit, the commit rule's predicate as the adoption map stood in that commit's own tree.

    A commit made before adoption.md was committed, or while its area was not yet `adopted`, was under no Boundary,
    so it is not judged by today's. When adoption.md has never been committed (it exists only in the working tree),
    every commit is judged by the current map, as before."""
    current = in_boundary(prd, repo_root)
    if prd.adoption is None:
        return lambda sha: current
    try:
        rel = (prd.root.resolve().relative_to(repo_root.resolve()) / ADOPTION_FILE).as_posix()
    except ValueError:
        return lambda sha: current
    if not (_git_out(repo_root, "log", "-1", "--format=%H", "--", rel) or "").strip():
        return lambda sha: current
    cache: dict[str, Callable[[str], bool] | None] = {}

    def at(sha: str) -> Callable[[str], bool] | None:
        text = _git_out(repo_root, "show", f"{sha}:{rel}")
        if text is None:
            return None
        if text not in cache:
            rows = _adoption({ADOPTION_FILE: text}) or []
            rxs = [glob_re(g) for r in rows if r.state == "adopted" for g in r.boundary]
            cache[text] = (lambda path: any(rx.match(path) for rx in rxs)) if rxs else None
        return cache[text]

    return at


def build_side(prd: Prd, level: str) -> bool:
    """A unit or build-gate level; a level with no Gate row counts as build, so trace fails closed."""
    return level == "unit" or gate_of(prd, level) != "deploy"


def run_trace(prd: Prd, repo_root: Path, rev_range: str | None) -> list[Finding]:
    scope = _in_scope(prd)
    cited = citations(prd, repo_root)
    findings: list[Finding] = []

    known = {tid: b for b in prd.blocks for tid, _, _ in b.tests}
    for tid, places in sorted(cited.items()):
        b = known.get(tid)
        why = "does not exist in the PRD" if b is None else "belongs to removed requirement " + b.id if b.status == "removed" else None
        if why:
            for file, line in places:
                findings.append(Finding(_rel(prd, repo_root / file), line, "test-cites-live", f"cites {tid}, which {why}"))

    for b in prd.blocks:
        if b.status in ("removed", "approved"):
            continue  # approved: nothing is built yet, so nothing need cite it
        for tid, level, line in b.tests:
            if tid in cited:
                continue
            if scope is not None and area(b.file) not in scope:
                continue
            if b.status != "live" and not build_side(prd, level):
                continue  # a deploy-gate test is cited by the time the block is live (0.5)
            findings.append(Finding(b.file, line, "t-implemented", f"{tid} ({b.id}) is cited by no test; add `@prd {tid}` to the test that proves it"))
            if b.status in ("verified", "live") or (b.status == "built" and level == "unit"):
                findings.append(Finding(b.file, line, "status-current", f"{b.id} is {b.status} but {tid} has no citing test"))

    tagged = tagged_citations(prd, repo_root)
    cases = {tc.id: tc for tc in prd.test_cases}
    for tc in prd.test_cases:
        eid = tc.data.get("known-failing")
        if isinstance(eid, str) and (tc.id, eid) not in tagged:
            findings.append(Finding(tc.file, tc.line, "known-failing-tags",
                                    f"{tc.id} is known-failing on {eid} but no citation is tagged `known-failing {eid}`"))
    for (tid, eid), places in sorted(tagged.items()):
        tc = cases.get(tid)
        entry = prd.errors_ledger.get(eid)
        for file, line in places:
            where = _rel(prd, repo_root / file)
            if tc is not None and tc.data.get("known-failing") != eid:
                findings.append(Finding(where, line, "known-failing-tags", f"tags {tid} known-failing {eid}, but its test case is not known-failing on {eid}"))
            if entry is not None and not entry.open:
                findings.append(Finding(where, line, "known-failing-tags", f"tags {tid} known-failing {eid}, which is resolved"))

    if rev_range:
        boundary_at = _boundary_at(prd, repo_root)
        for sha, body, files in _commits(repo_root, rev_range):
            for problem in changeset_problems(prd, body):
                findings.append(Finding("prd.md", 1, "commit-refs", f"commit {sha[:8]}: {problem}"))
            inside_boundary = boundary_at(sha)
            inside = [f for f in files if inside_boundary(f)] if inside_boundary else []
            if inside:
                for problem in refs_problems(prd, body):
                    findings.append(Finding("prd.md", 1, "commit-refs", f"commit {sha[:8]} touches {inside[0]} inside the Boundary: {problem}"))
    return sorted(findings)
