"""Context packs: the slice of a PRD one task needs, and nothing else."""
import json
import re
import subprocess
from dataclasses import asdict, dataclass
from itertools import groupby
from pathlib import Path

from .deps import require
from .markdown import Row, sections, tables
from .model import ADOPTION_FILE, UNMIGRATED, Prd, ReqBlock, _field_lines
from .rules.contracts import _custom_types

yaml = require("yaml", "pyyaml")

PARTS = ("Header", "Stack", "Glossary", "Area notes", "Requirements", "Code", "Practices", "Levels", "Harness defaults", "Rubric conventions", "Cited", "Upstream contracts", "Known defects", "Open questions", "History")
PARTS_REPO = ("Header", "Stack", "Areas")
MODES = ("decide", "implement")

_NFR = re.compile(r"(?<![\w-])NFR-\d+(?![\w-])")
_UJ = re.compile(r"(?<![\w-])UJ-\d+(?![\w-])")
_ASSUMPTION = re.compile(r"\[ASSUMPTION\b(?: (A-\d+):)?")
_TYPED = re.compile(r"(?<![\w-])([A-Za-z][\w-]*):([^\s`'\",;()\[\]]+)")  # <type>:<name>
_FEATURE = re.compile(r"features/([^/]+)\.md")
_SUB_ID = re.compile(r"(?:AC|T)-\d+\.\d+")
_ENTRY = re.compile(r"E-\d+")
_T_NUMBER = re.compile(r"T-(\d+)\.\d+")
_SOURCE_REF = re.compile(r"(?P<path>[^\s@]+):(?P<line>\d+)\s+@(?P<sha>[0-9a-fA-F]{4,40})")


@dataclass
class Item:
    part: str
    id: str | None
    file: str  # PRD-relative; repo-relative for Code items
    line: int | None
    text: str
    stale: bool = False  # the item is STALE, counted or not
    counted: bool = True  # false for a block pulled in through another block's Traces:
    moved: int | None = None  # a MOVED cited line's line number now


class ContextError(Exception):
    """A usage or input error: exit 2, nothing on stdout."""


def _word(term: str, flags: int = 0) -> re.Pattern:
    return re.compile(rf"(?<![\w-]){re.escape(term)}(?![\w-])", flags)


def _trim(lines: list[str]) -> str:
    while lines and not lines[-1].strip():
        lines = lines[:-1]
    return "\n".join(lines)


def _lines(prd: Prd, rel: str) -> list[str]:
    return prd.docs[rel].split("\n")


def _section(prd: Prd, number: int):
    return next((s for s in prd.sections if s.number == number), None)


def _table_text(prd: Prd, rows: list[Row], first_row: int) -> str:
    """A prd.md table's header and separator (the two lines above `first_row`) followed by `rows`."""
    lines = _lines(prd, "prd.md")
    return "\n".join(lines[first_row - 3 : first_row - 1] + [lines[r.line - 1] for r in rows])


def _plain(v):
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def _dump(key, value) -> str:
    return yaml.safe_dump({key: _plain(value)}, sort_keys=False, allow_unicode=True).rstrip("\n")


def _none(part: str, file: str) -> Item:
    return Item(part, None, file, None, "None.")


def _block_text(prd: Prd, b: ReqBlock, area: str) -> str:
    heading = _lines(prd, b.file)[b.line - 1]
    m = _FEATURE.fullmatch(b.file)
    if m and m.group(1) != area:
        heading += f" (area: {m.group(1)})"
    return _trim([heading] + [t for _, t in b.lines])


def _areas_known(prd: Prd) -> list[str]:
    known = [r.area for r in prd.adoption or []]
    return known + [m.group(1) for rel in prd.docs if (m := _FEATURE.fullmatch(rel)) and m.group(1) not in known]


def _sub_id_hint(prd: Prd, sid: str) -> str:
    """For an AC or T ID passed to --req: name the requirement it belongs to."""
    owners = [b.id for b in prd.blocks if any(a.id == sid for a in b.acs) or any(t == sid for t, _, _ in b.tests)]
    return f"pass the requirement ID ({', '.join(owners) or 'UJ-, FR- or NFR-nnn'}), not {sid}"


def _entry_reqs(prd: Prd, eid: str) -> list[str]:
    """The requirement IDs an errors.md entry reaches: its `Touches:` IDs, then the parent block
    of each test case `known-failing` on it (the owner of its `ac:`, else the T-id's number)."""
    ids = [t for t, _ in prd.errors_ledger[eid].touches]
    for tc in prd.test_cases:
        if not isinstance(tc.data, dict) or tc.data.get("known-failing") != eid:
            continue
        ac = str(tc.data.get("ac", ""))
        owner = next((b.id for b in prd.blocks if any(a.id == ac for a in b.acs)), None)
        if owner is None and (m := _T_NUMBER.fullmatch(tc.id)):
            owner = next((b.id for b in prd.blocks if b.kind in ("FR", "NFR") and int(b.id.split("-")[1]) == int(m.group(1))), None)
        if owner:
            ids.append(owner)
    return list(dict.fromkeys(ids))


def _select(prd: Prd, area: str, req: list[str] | None) -> tuple[list[ReqBlock], set[str], set[str]]:
    """The selected blocks, the errors.md entries --req named, and the IDs asked for (the rest were pulled in by Traces:)."""
    if req is None:
        blocks = [b for b in prd.blocks if b.file == f"features/{area}.md" and b.kind in ("UJ", "FR")]
        return blocks, set(), {b.id for b in blocks}
    by_id = {}
    for b in prd.blocks:
        by_id.setdefault(b.id, b)
    entries = [i for i in req if _ENTRY.fullmatch(i)]
    unknown = [i for i in req if i not in by_id and i not in entries]
    problems = [f"no requirement block defines {', '.join(unknown)}"
                + "".join(f"; {_sub_id_hint(prd, i)}" for i in unknown if _SUB_ID.fullmatch(i))] if unknown else []
    missing = [i for i in entries if i not in prd.errors_ledger]
    if missing:
        problems.append(f"errors.md has no entry {', '.join(missing)}")
    if problems:
        raise ContextError("; ".join(problems))
    roots = [i for i in req if i not in entries] + [r for e in entries for r in _entry_reqs(prd, e) if r in by_id]
    wanted = set(roots)
    for i in roots:
        for _, text in _field_lines(by_id[i].lines, "Traces"):
            wanted |= {u for u in _UJ.findall(text) if u in by_id}
    return [b for b in by_id.values() if b.id in wanted], set(entries), set(roots)


def _stack(prd: Prd) -> list[Item]:
    items = []
    for number in (1, 4):
        s = _section(prd, number)
        if s:
            heading = "#" + _lines(prd, "prd.md")[s.line - 1]  # demoted under the part heading
            items.append(Item("Stack", None, "prd.md", s.line, _trim([heading] + [t for _, t in s.body])))
    return items or [_none("Stack", "prd.md")]


def _glossary(prd: Prd, text: str) -> list[Item]:
    s3 = _section(prd, 3)
    ts = tables(s3.body) if s3 else []
    if not ts or not ts[0].rows:
        return [_none("Glossary", "prd.md")]
    hits = [r for r in ts[0].rows if r.cells and r.cells[0].strip("`").strip()
            and _word(r.cells[0].strip("`").strip(), re.I).search(text)]
    first = ts[0].rows[0].line
    return [Item("Glossary", None, "prd.md", first - 2, _table_text(prd, hits, first))] if hits else [_none("Glossary", "prd.md")]


def _cited(prd: Prd, area: str, blocks: list[ReqBlock], text: str) -> list[Item]:
    items: list[Item] = []
    chosen = {b.id for b in blocks}
    nfrs = set(_NFR.findall(text)) - chosen
    seen: set[str] = set()
    for b in prd.blocks:
        if b.id in nfrs and b.id not in seen:
            seen.add(b.id)
            items.append(Item("Cited", b.id, b.file, b.line, _block_text(prd, b, area)))

    codes = {c for b in blocks for c, _ in b.errors}
    errors = prd.yaml.get("contracts/errors.yaml")
    errors = errors if isinstance(errors, dict) else {}
    for code in [c for c in errors if c in codes] + sorted(codes - set(errors)):
        if code in errors:
            items.append(Item("Cited", code, "contracts/errors.yaml", errors.key_lines.get(code), _dump(code, errors[code])))
        else:
            items.append(Item("Cited", code, "contracts/errors.yaml", None, f"{code}: not in contracts/errors.yaml"))

    from .rules.contracts import pack_kinds
    kinds = pack_kinds(prd)  # a pack's target kind (`doc`) resolves to its contract type (`outline`)
    typed = {(kinds.get(m.group(1), m.group(1)), m.group(2).rstrip(".:")) for m in _TYPED.finditer(text)}
    tests = {t for b in blocks for t, _, _ in b.tests}
    for tc in prd.test_cases:  # the targets of the selected requirements' tests, when a pack names their kind
        target = tc.data.get("target") if isinstance(tc.data, dict) else None
        m = _TYPED.fullmatch(target) if isinstance(target, str) else None
        if tc.id in tests and m and m.group(1) in kinds:
            typed.add((kinds[m.group(1)], m.group(2)))
    for kind, _, files, _ in _custom_types(prd):  # resolved as contracts-valid resolves custom_items
        for f in files:
            data = prd.yaml.get(f)
            for key in data if isinstance(data, dict) else []:
                tid = f"{kind}:{key}"
                if (kind, str(key)) in typed and tid not in seen:
                    seen.add(tid)
                    items.append(Item("Cited", tid, f, data.key_lines.get(key), _dump(key, data[key])))

    aids = {m.group(1) for m in _ASSUMPTION.finditer(text) if m.group(1)}
    if prd.assumptions:
        first = prd.assumptions[0].line
        for r in prd.assumptions:
            aid = r.cells[0].strip("`") if r.cells else ""
            if aid in aids and aid not in seen:
                seen.add(aid)
                items.append(Item("Cited", aid, "prd.md", r.line, _table_text(prd, [r], first)))
    return items or [_none("Cited", "prd.md")]


def _upstream_contracts(prd: Prd, blocks: list[ReqBlock], text: str) -> list[Item]:
    """One item per prefixed upstream reference the selected requirements touch (by ID, AC, T-id or prose), with its snapshot text."""
    from . import citations, snapshot

    mine = {b.id for b in blocks} | {ac.id for b in blocks for ac in b.acs} | {t for b in blocks for t, _, _ in b.tests}
    items: list[Item] = []
    seen: set[str] = set()
    for c in citations.cites(prd):
        label = f"{c.kind}:{c.upstream}/{c.name}"
        if label in seen or not (c.label in mine or c.ref in text):
            continue
        seen.add(label)
        snaps = prd.snapshots.get(c.upstream)
        body = snapshot.item_text(snapshot.contracts_of_snapshot(snaps), c.kind, c.name) if snaps else None
        items.append(Item("Upstream contracts", label, f"contracts/upstream/{c.upstream}", None,
                          body if body is not None else f"{label}: not in the snapshot"))
    return items or ([_none("Upstream contracts", "links.md")] if prd.links is not None else [])


def _defects(prd: Prd, ids: set[str], entries: set[str]) -> list[Item]:
    """Each entry --req named, whole, and each open entry whose `Touches:` names a selected ID."""
    items, loose = [], 0
    lines = _lines(prd, "errors.md") if "errors.md" in prd.docs else []
    for e in prd.errors_ledger.values():
        if e.id in entries or (e.open and any(t in ids for t, _ in e.touches)):
            items.append(Item("Known defects", e.id, "errors.md", e.line, _trim(lines[e.line - 1 : e.end])))
        elif e.open and not e.touches:
            loose += 1
    return items + [Item("Known defects", None, "errors.md", None, f"{loose} open errors.md entries name no requirement")]


def _questions(prd: Prd, patterns: list[re.Pattern]) -> list[Item]:
    s13 = _section(prd, 13)
    found: list[tuple[int, list[str]]] = []
    for n, text in s13.body if s13 else []:
        if text.startswith("- "):
            found.append((n, [text]))
        elif found and text.startswith((" ", "\t")) and text.strip() and found[-1][0] + len(found[-1][1]) == n:
            found[-1][1].append(text)
    items = [Item("Open questions", None, "prd.md", n, "\n".join(q)) for n, q in found
             if any(p.search("\n".join(q)) for p in patterns)]
    rest = len(found) - len(items)
    return items + [Item("Open questions", None, "prd.md", None, f"{rest} other open questions in prd.md §13")]


def _history(prd: Prd, area: str) -> list[Item]:
    s14 = _section(prd, 14)
    ts = tables(s14.body) if s14 else []
    lines = _lines(prd, "prd.md")
    slug = _word(area)
    rows = [r for r in (ts[0].rows if ts else []) if slug.search(lines[r.line - 1])][-3:]
    if not rows:
        return [_none("History", "prd.md")]
    first = ts[0].rows[0].line
    return [Item("History", None, "prd.md", first - 2, _table_text(prd, rows, first))]


def _areas(prd: Prd) -> list[Item]:
    if prd.adoption is not None:
        items = [Item("Areas", r.area, ADOPTION_FILE, r.line,
                      f"- {r.area} ({r.state}; Boundary: {', '.join(r.boundary)})" if r.boundary else f"- {r.area} ({r.state})")
                 for r in prd.adoption]
    else:
        items = [Item("Areas", m.group(1), rel, None, f"- {m.group(1)}") for rel in prd.docs if (m := _FEATURE.fullmatch(rel))]
    return items or [_none("Areas", ADOPTION_FILE if prd.adoption is not None else "prd.md")]


def _header(prd: Prd, area: str | None, mode: str, display: str, body: list[Item]) -> Item:
    n = len(render_text(body).encode())
    size = f"pack {n:,} bytes (~{n / 4 / 1000:.1f}k tokens, bytes / 4); prd.md {(prd.root / 'prd.md').stat().st_size:,}"
    lines = [f"PRD: {display or prd.root.as_posix()} version {prd.frontmatter.get('version', '-')} mode {mode}"]
    if area is not None:
        feature = prd.root / f"features/{area}.md"
        if feature.is_file():
            size += f"; features/{area}.md {feature.stat().st_size:,}"
        row = next((r for r in prd.adoption or [] if r.area == area), None)
        state = f"{row.state}; Boundary: {', '.join(row.boundary)}" if row and row.boundary else (row.state if row else "-")
        lines.append(f"Area: {area} ({state})")
        lines.append(_profile_text(prd, area))
    return Item("Header", None, "prd.md", None, "\n".join(lines + [size]))


def _profile_text(prd: Prd, area: str) -> str:
    from . import packs

    ref, lang = packs.profile(prd, area)
    which = f"pack {ref.name} {ref.version} ({ref.source})" if ref.version else f"pack {ref.name} (default)"
    return f"Target: {which}, output language {lang}"


def _harness(prd: Prd, area: str) -> list[Item]:
    from . import packs

    pack = packs.pack_for(prd, area)
    slots = pack.harness if pack else {}
    if not slots:
        return []
    text = "\n".join(f"- **{slot}.** {value}" for slot, value in slots.items())
    return [Item("Harness defaults", None, f"pack {pack.name} {pack.version}", None, text)]


def _rubrics(prd: Prd, area: str) -> list[Item]:
    from . import packs
    from .rules.testcases import is_judged

    pack = packs.pack_for(prd, area)
    judged = any(tc.file == f"test-cases/{area}.yaml" and isinstance(tc.data, dict) and is_judged(tc) for tc in prd.test_cases)
    if not (pack and pack.rubrics and judged):
        return []
    try:
        text = pack.rubrics.read_text(encoding="utf-8").rstrip("\n")
    except OSError:
        return []
    return [Item("Rubric conventions", None, f"pack {pack.name} {pack.version}", None, text)]


def _git(root: Path, *args: str) -> subprocess.CompletedProcess | None:
    """A git call in `root`; None when git cannot run or times out."""
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None


def _stale_reason(root: Path, path: str, sha: str, target: Path) -> str | None:
    """The whole-file rule, for a blank cited line: changed since the commit, or uncommitted changes."""
    log = _git(root, "log", "--format=%H", f"{sha}..HEAD", "--", path)
    if log is None or log.returncode != 0:
        return f"cannot compare with {sha}"
    if log.stdout.strip():
        return f"changed since {sha}"
    diff = _git(root, "diff", "--quiet", "HEAD", "--", path)
    if diff is None or diff.returncode not in (0, 1):
        return f"cannot compare with {sha}"
    return "uncommitted changes" if diff.returncode else None


def _rows(data: bytes) -> list[str]:
    rows = data.decode("utf-8", errors="replace").split("\n")
    return [r.rstrip("\r") for r in (rows[:-1] if rows and rows[-1] == "" else rows)]


def line_state(root: Path, path: str, line: int, sha: str) -> tuple[str, int | None, str | None]:
    """How the cited line stands: ("current", None, None), ("moved", <new line>, None) or ("stale", None, <reason>).

    The text at `<path>:<line>` in commit `sha` is compared, whitespace stripped, with the file as it is now.
    """
    target = (root / path).resolve()
    if not target.is_relative_to(root.resolve()):
        target = root / "<outside repository>"
    ok = _git(root, "cat-file", "-e", f"{sha}^{{commit}}")
    if ok is None or ok.returncode != 0:
        return "stale", None, f"unknown commit {sha}"
    if not target.is_file():
        return "stale", None, "file missing"
    old = _git(root, "show", f"{sha}:{path}")
    if old is None or old.returncode != 0:
        return "stale", None, f"{path} is not in {sha}"
    then = _rows(old.stdout.encode("utf-8", errors="replace"))
    if line < 1 or line > len(then):
        return "stale", None, f"line {line} is past the end ({len(then)} lines)"
    wanted = then[line - 1].strip()
    if not wanted:
        reason = _stale_reason(root, path, sha, target)
        return ("stale", None, reason) if reason else ("current", None, None)
    now = [r.strip() for r in _rows(target.read_bytes())]
    if line <= len(now) and now[line - 1] == wanted:
        return "current", None, None
    hits = [n for n, r in enumerate(now, 1) if r == wanted]
    if len(hits) == 1:
        return "moved", hits[0], None
    return "stale", None, "the cited line's text is gone" if not hits else f"the cited line's text appears {len(hits)} times"


_PULLED = " (pulled in; not counted)"


def _excerpt(root: Path, block: ReqBlock, path: str, line: int, sha: str, context: int, counted: bool = True) -> Item:
    state, moved, reason = line_state(root, path, line, sha)
    target = (root / path).resolve()
    shown: list[str] = []
    centre = moved or line
    if target.is_file() and target.is_relative_to(root.resolve()):
        rows = _rows(target.read_bytes())
        lo, hi = max(1, centre - context), min(len(rows), centre + context)
        shown = [f"{n:>5}  {rows[n - 1]}" for n in range(lo, hi + 1)]
    head = [f"### {path}:{line} @{sha}"]
    if state == "moved":
        head.append(f"MOVED: line {line} is now line {moved}")
    elif reason:
        whole_file = reason.startswith(("changed since", "uncommitted changes", "cannot compare"))
        head.append(f"STALE: {reason}" + ("; the cited line may have moved" if whole_file else "") + ("" if counted else _PULLED))
    return Item("Code", block.id, path, line, "\n".join(head + shown), stale=bool(reason), counted=counted,
                moved=moved if state == "moved" else None)


def _refs(b: ReqBlock) -> list[tuple[str, int, str]]:
    return [(m["path"], int(m["line"]), m["sha"]) for m in _SOURCE_REF.finditer(b.source or "")]


def _code(blocks: list[ReqBlock], area: str, root: Path, context: int, counted: set[str] | None = None) -> list[Item]:
    def mine(b: ReqBlock) -> bool:
        return counted is None or b.id in counted

    owner: dict[tuple[str, int, str], str] = {}  # one excerpt per ref, owned by its first asked block, else its first block
    for b in sorted(blocks, key=lambda b: not mine(b)):  # stable: file order within asked, then pulled in
        for ref in _refs(b):
            owner.setdefault(ref, b.id)
    items = []
    for b in blocks:
        if b.source and not _SOURCE_REF.search(b.source):
            line = _field_lines(b.lines, "Source")[0][0]
            items.append(Item("Code", b.id, b.file, line,
                              f"### {b.id} Source: {b.source}\nSTALE: Source not in <path>:<line> @<sha> form" + ("" if mine(b) else _PULLED),
                              stale=True, counted=mine(b)))
        for ref in _refs(b):
            if owner.get(ref) == b.id:
                del owner[ref]  # a block citing the same ref twice gets one excerpt
                items.append(_excerpt(root, b, *ref[:2], ref[2], context, mine(b)))
    return items or [_none("Code", f"features/{area}.md")]


def _area_paths(prd: Prd, area: str, root: Path) -> list[str]:
    """The paths of an area (AC-055.2): each file git lists that a glob of its Boundary cell matches, and each glob
    with no `*` and no `?` as a path; with no adoption.md, each file git lists outside the PRD folder and .prd-toolkit/."""
    from .trace import glob_re, in_boundary

    r = _git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    listed = list(dict.fromkeys(p for p in r.stdout.split("\0") if p)) if r is not None and r.returncode == 0 else []
    if prd.adoption is None:
        outside = in_boundary(prd, root)  # with no adoption map: outside the PRD folder and .prd-toolkit/
        return [p for p in listed if outside(p)]
    row = next((a for a in prd.adoption if a.area == area), None)
    if row is None:
        return []
    rxs = [glob_re(g) for g in row.boundary]
    named = [g for g in row.boundary if "*" not in g and "?" not in g]
    return list(dict.fromkeys([p for p in listed if any(rx.match(p) for rx in rxs)] + named))


def _practices(prd: Prd, area: str, root: Path) -> list[Item]:
    """The `code` practices whose glob matches a path of the area (AC-055.1); no part without practices.md."""
    from . import practices

    if practices.FILE not in prd.docs:
        return []
    hits = practices.matching(practices.load(prd).practices, _area_paths(prd, area, root))
    items = [Item("Practices", p.id, practices.FILE, p.line, f"{p.id} ({p.source}): {p.practice}") for p in hits]
    return items or [_none("Practices", practices.FILE)]


def _levels(prd: Prd) -> list[Item]:
    if "testing.md" not in prd.docs:
        return [_none("Levels", "testing.md")]
    sec = next((s for s in sections(prd.docs["testing.md"]) if s.title.strip().lower() == "levels"), None)
    ts = tables(sec.body) if sec else []
    if not ts or not ts[0].rows:
        return [_none("Levels", "testing.md")]
    lines = _lines(prd, "testing.md")
    first = ts[0].rows[0].line
    text = "\n".join(lines[first - 3 : first - 1] + [lines[r.line - 1] for r in ts[0].rows])
    return [Item("Levels", None, "testing.md", first - 2, text)]


def _in_git_work_tree(path: Path) -> bool:
    r = _git(path, "rev-parse", "--is-inside-work-tree")
    return r is not None and r.returncode == 0 and r.stdout.strip() == "true"


def build_pack(prd: Prd, area: str | None, req: list[str] | None, mode: str = "decide",
               context: int = 20, repo_root: Path | None = None, display: str = "") -> list[Item]:
    """The pack's items, in part order. Raises ContextError for every exit-2 condition."""
    if prd.adoption_unmigrated:
        raise ContextError(f"{prd.root.as_posix()}/prd.md: {UNMIGRATED}")
    if mode not in MODES:
        raise ContextError(f"--for must be one of {', '.join(MODES)}")
    if req is not None and not req:
        raise ContextError("--req names no ID")
    if area is None:
        if req is not None:
            raise ContextError("--req needs --area")
        if mode == "implement":
            raise ContextError("--for implement needs --area")
        body = _stack(prd) + _areas(prd)
        return [_header(prd, None, mode, display, body)] + body
    known = _areas_known(prd)
    if area not in known:
        raise ContextError(f"unknown area '{area}'; areas: {', '.join(known) or 'none'}")

    if mode == "implement" and not _in_git_work_tree(prd.root):
        raise ContextError("--for implement needs the PRD inside a git work tree")
    blocks, entries, asked = _select(prd, area, req)
    texts = [_block_text(prd, b, area) for b in blocks]
    text = "\n".join(texts)
    ids = {b.id for b in blocks}
    requirements = [Item("Requirements", b.id, b.file, b.line, t) for b, t in zip(blocks, texts)]
    patterns = [_word(i) for i in sorted(ids | {ac.id for b in blocks for ac in b.acs})] + [_word(area)]
    implement = (_code(blocks, area, repo_root or prd.root, context, asked) + _practices(prd, area, repo_root or prd.root) + _levels(prd) + _harness(prd, area) + _rubrics(prd, area)) if mode == "implement" else []
    from . import contextnotes
    notes = contextnotes.part(prd, area)  # FR-072: directly before Requirements, none without area notes
    body = (_stack(prd) + _glossary(prd, text) + notes + (requirements or [_none("Requirements", f"features/{area}.md")])
            + implement + _cited(prd, area, blocks, text) + _upstream_contracts(prd, blocks, text) + _defects(prd, ids, entries) + _questions(prd, patterns) + _history(prd, area))
    return [_header(prd, area, mode, display, body)] + body


def render_text(items: list[Item]) -> str:
    """Each part under a `## <part>` heading, its items separated by a blank line (Areas: one line each)."""
    return "\n".join(f"## {part}\n\n" + ("\n" if part == "Areas" else "\n\n").join(i.text for i in group) + "\n"
                     for part, group in groupby(items, key=lambda i: i.part))


def render_json(items: list[Item]) -> str:
    return json.dumps([asdict(i) for i in items], indent=2, ensure_ascii=False) + "\n"


def render_document(prd: Prd, area: str | None, req: list[str] | None, mode: str, items: list[Item]) -> str:
    from . import interface
    fm = prd.frontmatter
    parts = [{"title": i.part, "id": i.id, "file": i.file, "line": i.line, "text": i.text, "stale": i.stale,
              "counted": i.counted, "moved": i.moved} for i in items]
    return interface.dump("context", {"prd": fm.get("prd"), "mode": mode, "area": area, "ids": list(req or []), "parts": parts})
