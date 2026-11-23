"""Structure rules: frontmatter, sections, placeholders, vague words, markers, assumptions, glossary."""
import re
from collections.abc import Iterator

from .. import languages
from ..deps import require
from ..findings import Finding
from ..markdown import mask_quoted, strip_code, tables
from ..model import ADOPTION_FILE, ADOPTION_STATES, UNMIGRATED, UPSTREAM_DIR, Prd
from ..registry import rule

SECTION_TITLES = [
    "Metadata & stack", "Summary & goals", "Glossary", "Architecture", "Standards registry",
    "Skills registry", "Contract types", "Adoption map", "Versioning", "Design & UI",
    "Requirement index", "Assumptions index", "Open questions", "Changelog",
]
MANDATORY = ["features/", "test-cases/", "nfr.md", "testing.md", "operations.md", "errors.md", "contracts/errors.yaml"]
# slot name -> alternatives that fill it
OPTIONAL = {
    "contracts/openapi.yaml": ["contracts/openapi.yaml"],
    "contracts/schema.sql": ["contracts/schema.sql"],
    "contracts/events.md": ["contracts/events.md", "contracts/asyncapi.yaml"],
    "contracts/permissions.yaml": ["contracts/permissions.yaml"],
    "contracts/config.yaml": ["contracts/config.yaml"],
    "contracts/data-classification.yaml": ["contracts/data-classification.yaml"],
    "contracts/dependencies/": ["contracts/dependencies/"],
    "contracts/fixtures/": ["contracts/fixtures/"],
}
# the slots of testing.md's `## Harness` section, in template order
HARNESS_SLOTS = ["Lifecycle", "Environment switch", "Database access", "Tools on the runner",
                 "Clean state", "Persistent environments", "Layout", "HTTP requests", "Fixtures",
                 "Browser identity", "Assertions", "Waits", "Effects", "Leaks", "Acceptance"]
STATUSES = ("Draft", "In review", "Approved")


def prose(prd: Prd) -> Iterator[tuple[str, int, str]]:
    """Every markdown line of the PRD as (file, line, text), with code blocks and spans blanked.

    errors.md's `Evidence:` and `Confirmed:` lines are quoted material, not PRD prose, so they are
    blanked too."""
    for rel, text in prd.docs.items():
        stripped = strip_code(text)
        if rel == "errors.md":
            stripped = mask_quoted(stripped)
        for n, line in enumerate(stripped.split("\n"), 1):
            yield rel, n, line


def _hidden(rel: str) -> bool:
    """True when a path relative to the PRD folder has a part starting with `.`: not part of the PRD."""
    return any(part.startswith(".") for part in rel.split("/"))


def _visible_prose(prd: Prd) -> Iterator[tuple[str, int, str]]:
    """prose(), without the lines of hidden Markdown files."""
    for rel, n, text in prose(prd):
        if not _hidden(rel):
            yield rel, n, text


_RAW_SUFFIXES = {".yaml", ".yml", ".sql", ".json"}


def all_lines(prd: Prd) -> Iterator[tuple[str, int, str]]:
    """Every text line of every file under the PRD folder as (file, line, text).

    Markdown comes from prose() (code blanked); YAML, SQL and JSON files are read raw, so markers
    in their values and comments count. Fixture data under contracts/fixtures/, other file types,
    upstream snapshots (contracts/upstream/, in a PRD with links.md), and hidden or editor-backup files (`.x.swp`, `x~`, `x.bak`) are skipped, as are binary files."""
    yield from _visible_prose(prd)
    for p in sorted(prd.root.rglob("*")):
        if not p.is_file() or p.suffix not in _RAW_SUFFIXES:
            continue
        rel_parts = p.relative_to(prd.root).parts
        skipped = (("contracts", "fixtures"), tuple(UPSTREAM_DIR.split("/"))) if prd.links is not None else (("contracts", "fixtures"),)
        if rel_parts[:2] in skipped or any(part.startswith(".") for part in rel_parts):
            continue
        try:
            raw = p.read_bytes()
            if b"\0" in raw:
                continue
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = p.relative_to(prd.root).as_posix()
        for n, line in enumerate(text.split("\n"), 1):
            yield rel, n, line


def _status(prd: Prd) -> str:
    return prd.frontmatter.get("status", "")


def _fm_line(prd: Prd, key: str) -> int:
    """The line of `<key>:` inside prd.md's frontmatter block, or line 1 when the block has none.

    Lines below the closing `---` are never looked at."""
    if prd.frontmatter_line:
        for n, line in enumerate(prd.docs["prd.md"].split("\n")[1:], 2):
            if line.strip() == "---":
                break
            if line.startswith(key + ":"):
                return n
    return 1


def _exists(prd: Prd, path: str) -> bool:
    p = prd.root / path
    if path.endswith("/"):
        if path == "features/":
            return any(prd.root.glob("features/*.md"))
        if path == "test-cases/":
            return any(prd.root.glob("test-cases/*.yaml"))
        return p.is_dir() and any(f.is_file() for f in p.rglob("*"))
    return p.is_file()


@rule("frontmatter", description="Checks prd.md's frontmatter keys: prd a lowercase slug equal to the folder name, version X.Y.Z, status Draft, In review or Approved, a non-empty owner, updated YYYY-MM-DD, an optional language of two or three lowercase letters, and a valid sql-dialect when contracts/schema.sql exists. Correct the key the message names.")
def frontmatter(prd: Prd):
    fm = prd.frontmatter
    f = lambda key, msg: Finding("prd.md", _fm_line(prd, key), "frontmatter", msg)  # noqa: E731
    checks = {
        "prd": (lambda v: re.fullmatch(r"[a-z][a-z0-9-]*", v) and v == prd.root.name, f"must be a lowercase slug equal to the folder name '{prd.root.name}'"),
        "version": (lambda v: re.fullmatch(r"\d+\.\d+\.\d+", v), "must be X.Y.Z, digits only"),
        "status": (lambda v: v in STATUSES, "must be Draft, In review or Approved"),
        "owner": (lambda v: bool(v), "must not be empty"),
        "updated": (lambda v: re.fullmatch(r"\d{4}-\d{2}-\d{2}", v), "must be YYYY-MM-DD"),
    }
    if "language" in fm:
        checks["language"] = (lambda v: re.fullmatch(r"[a-z]{2,3}", v), "must match ^[a-z]{2,3}$")
    for key, (ok, msg) in checks.items():
        if key not in fm:
            yield f(key, f"missing key '{key}'")
        elif not ok(fm[key]):
            yield f(key, f"'{key}: {fm[key]}' {msg}")
    if (prd.root / "contracts/schema.sql").is_file():
        dialect = fm.get("sql-dialect")
        if not dialect:
            yield f("sql-dialect", "missing key 'sql-dialect' (required because contracts/schema.sql exists)")
        else:
            sqlglot = require("sqlglot", "sqlglot")
            try:
                sqlglot.Dialect.get_or_raise(dialect)
            except Exception as exc:
                yield f("sql-dialect", f"'sql-dialect: {dialect}' is not a sqlglot dialect ({exc})")


@rule("language-table", description="Checks that the language the frontmatter names (en when it names none) has a usable table, the toolkit's own or one in a pack the PRD names. Set language: to a code that has a table, or fix or restore the table file the message names.")
def language_table(prd: Prd):
    why = languages.problem(prd)
    if why:
        yield Finding("prd.md", _fm_line(prd, "language"), "language-table", why)


@rule("sections", description="Checks prd.md's fourteen numbered sections, once each and in order, with no other, the mandatory files, never marked Not applicable, a section 1 Not applicable line for each absent optional contract, the section 8 body and the adoption.md table, and testing.md's Harness slots, once each and in order, with a Test roots list. Add, move, rename or delete what the message names, exactly as prd-format.md spells it.")
def sections(prd: Prd):
    actual = [(s.number, s.title) for s in prd.sections]
    expected = list(enumerate(SECTION_TITLES, 1))
    line_of = {(s.number, s.title): s.line for s in prd.sections}
    for num, title in expected:
        if (num, title) not in actual:
            yield Finding("prd.md", 1, "sections", f"missing section '## {num}. {title}'")
    present = [e for e in expected if e in actual]
    firsts = []  # each expected section at its first heading; a later one is a duplicate
    for s in prd.sections:
        key = (s.number, s.title)
        if key not in expected:
            continue
        if key in firsts:
            yield Finding("prd.md", s.line, "sections", f"duplicate section '## {key[0]}. {key[1]}'")
        else:
            firsts.append(key)
    if firsts != present:
        yield Finding("prd.md", 1, "sections", "sections are out of order")
    for a in actual:
        if a not in expected:
            heading = f"## {a[1]}" if a[0] is None else f"## {a[0]}. {a[1]}"
            yield Finding("prd.md", line_of[a], "sections", f"unexpected section '{heading}'")
    na = {k.rstrip("/") + ("/" if k.endswith("/") else ""): v for k, v in prd.not_applicable.items()}
    for path in MANDATORY:
        hit = na.get(path) or na.get(path.rstrip("/"))
        if hit:
            yield Finding("prd.md", hit[1], "sections", f"mandatory '{path}' cannot be marked not applicable")
        elif not _exists(prd, path):
            yield Finding(path.rstrip("/"), 0, "sections", f"mandatory '{path}' is missing")
    for slot, alts in OPTIONAL.items():
        if any(_exists(prd, a) for a in alts):
            continue
        if not any(a in na or a.rstrip("/") in na for a in alts):
            yield Finding("prd.md", 1, "sections", f"'{slot}' is absent and section 1 has no 'Not applicable: `{slot}` — reason' line")
    yield from _adoption_findings(prd)
    yield from _harness_findings(prd)


def _adoption_findings(prd: Prd) -> Iterator[Finding]:
    s8 = next((s for s in prd.sections if s.number == 8), None)
    if s8:
        body = "\n".join(t for _, t in s8.body).strip()
        norm = body.removesuffix(".").strip()
        has_file = ADOPTION_FILE in prd.docs
        if tables(s8.body):
            yield Finding("prd.md", s8.line, "sections", UNMIGRATED)
        elif "NEEDS CLARIFICATION" in body:
            pass  # a draft marker; markers-open reports it
        elif norm == f"See {ADOPTION_FILE}":
            if not has_file:
                yield Finding("prd.md", s8.line, "sections", f'section 8 points at {ADOPTION_FILE} but {ADOPTION_FILE} does not exist')
        elif norm == "Not applicable: new project":
            if has_file:
                yield Finding("prd.md", s8.line, "sections", f'section 8 says "Not applicable: new project" but {ADOPTION_FILE} exists')
        else:
            yield Finding("prd.md", s8.line, "sections", f'section 8 body must be "See {ADOPTION_FILE}." or "Not applicable: new project."')
    if ADOPTION_FILE not in prd.docs:
        return
    ts = tables([(n, line) for n, line in enumerate(prd.docs[ADOPTION_FILE].split("\n"), 1)])
    if not ts:
        yield Finding(ADOPTION_FILE, 1, "sections", f"{ADOPTION_FILE} holds no '| Area | State | Boundary |' table")
        return
    header = [c.strip().strip("`") for c in ts[0].header]
    if header != ["Area", "State", "Boundary"]:
        yield Finding(ADOPTION_FILE, ts[0].line, "sections", f"{ADOPTION_FILE} table header must be '| Area | State | Boundary |', not '| {' | '.join(header)} |'")
    for row in prd.adoption or []:
        if row.state not in ADOPTION_STATES:
            yield Finding(ADOPTION_FILE, row.line, "sections", f"adoption state '{row.state}' for {row.area} must be one of {', '.join(ADOPTION_STATES)}")


def _harness_findings(prd: Prd) -> Iterator[Finding]:
    if "testing.md" not in prd.docs:
        return  # the mandatory-file check reports it
    h = prd.testing.harness
    if not h.slots:
        yield Finding("testing.md", 1, "sections", "testing.md has no '## Harness' section with its slots")
        return
    names = [n for n, _ in h.slots]
    for slot in HARNESS_SLOTS:
        if slot not in names:
            yield Finding("testing.md", h.slots[0][1], "sections", f"Harness slot '{slot}' is missing")
    firsts = []  # each known slot at its first bullet; a later one is a duplicate
    for name, line in h.slots:
        if name not in HARNESS_SLOTS:
            continue
        if name in firsts:
            yield Finding("testing.md", line, "sections", f"Harness slot '{name}' appears twice")
        else:
            firsts.append(name)
    if firsts != [n for n in HARNESS_SLOTS if n in names]:
        yield Finding("testing.md", h.slots[0][1], "sections", f"Harness slots are out of order; the order is {', '.join(HARNESS_SLOTS)}")
    layout = next((n for name, n in h.slots if name == "Layout"), None)
    if layout and h.test_roots is None:
        yield Finding("testing.md", layout, "sections", "the Harness Layout slot has no 'Test roots:' text")
    elif layout and h.test_roots == []:
        text = prd.docs["testing.md"].split("\n")[h.test_roots_line - 1].split("Test roots:", 1)[1]
        if "[NEEDS CLARIFICATION" not in text:  # a marker in the list itself is markers-open's to report
            # the guard would then block every write, and trace would fall back to tests/
            yield Finding("testing.md", h.test_roots_line, "sections", "Test roots: lists no backticked directory")


# only the template's own slots count; any other {{...}} (a Mustache message, say) is content
_SLOT = r"\{\{(?:project|owner|date|sql_dialect)\}\}"
_PLACEHOLDER = re.compile(r"\b(?:TBD|TODO)\b|\?\?\?|" + _SLOT + r"|<(?!https?://)[A-Za-z][^<>\n]*>")
_SCALAR_PLACEHOLDER = re.compile(r"\b(?:TBD|TODO)\b|\?\?\?|" + _SLOT)


def _scalars(node, line: int) -> Iterator[tuple[int, str]]:
    if isinstance(node, dict):
        for k, v in node.items():
            kl = getattr(node, "key_lines", {}).get(k, line)
            yield from _scalars(v, kl)
    elif isinstance(node, (list, tuple)):
        for v in node:
            yield from _scalars(v, line)
    elif isinstance(node, str):
        yield line, node


@rule("placeholder", description="Checks prose and YAML values for unfilled template slots: TBD, TODO, ???, a template variable, and in prose a bare angle-bracket name. Fill the slot, or put literal angle-bracket text in backticks.")
def placeholder(prd: Prd):
    for rel, n, text in _visible_prose(prd):
        m = _PLACEHOLDER.search(text)
        if m:
            yield Finding(rel, n, "placeholder", f"placeholder '{m.group(0)}' in prose; if this is literal text, put it in backticks")
    sources = [(rel, data) for rel, data in prd.yaml.items()] + [(tc.file, tc.data) for tc in prd.test_cases]
    for rel, data in (s for s in sources if not _hidden(s[0])):
        for n, value in _scalars(data, 1):
            m = _SCALAR_PLACEHOLDER.search(value)
            if m:
                yield Finding(rel, n, "placeholder", f"placeholder '{m.group(0)}' in a YAML value")


_ID = re.compile(r"\b(?:AC|FR|NFR|UJ|T)-\d+(?:\.\d+)?\b")


def _removed_ac_lines(b) -> set[int]:
    """Line numbers of a block's removed ACs, continuation lines included."""
    out: set[int] = set()
    starts = {a.line for a in b.acs if a.removed}
    on = False
    for n, text in b.lines:
        if n in starts:
            on = True
        elif not (on and text.startswith("  ") and text.strip()):
            on = False
        if on:
            out.add(n)
    return out


@rule("vague-word", description="Checks each live AC line, and each line of an NFR, for a word of the language table's vague list (such as fast or secure) on a line with no number outside its IDs. Replace the word with a measurable bound, such as within 200 ms.")
def vague_word(prd: Prd):
    table = languages.for_prd(prd)
    if table is None:
        return
    vague = table.vague

    def check(file, n, text):
        m = vague.search(text)
        if m and not re.search(r"\d", _ID.sub("", text)):
            return Finding(file, n, "vague-word", f"'{m.group(1)}' with no measurable number on the line")

    for b in prd.blocks:
        if b.kind == "NFR":
            stripped = strip_code("\n".join(t for _, t in b.lines)).split("\n")
            retired = _removed_ac_lines(b)
            items = [(n, t) for (n, _), t in zip(b.lines, stripped) if n not in retired]
        else:
            items = [(a.line, strip_code(a.text)) for a in b.acs if not a.removed]
        for n, t in items:
            f = check(b.file, n, t)
            if f:
                yield f


@rule("markers-open", description="Checks that no clarification marker remains in the PRD's Markdown prose (code spans and blocks aside) or its YAML, SQL and JSON files, comments included, outside contracts/fixtures/, upstream snapshots and change-set records, once the status is In review or Approved. Answer the question and delete the marker, or move the status back to Draft.")
def markers_open(prd: Prd):
    if _status(prd) not in ("In review", "Approved"):
        return
    for rel, n, text in all_lines(prd):
        if "[NEEDS CLARIFICATION" in text:
            yield Finding(rel, n, "markers-open", f"[NEEDS CLARIFICATION] left open while status is {_status(prd)} (markers count in every text file, comments included; delete a template hint once its slot is answered)")


_MARKER = re.compile(r"\[ASSUMPTION\b(?: (A-\d+):)?")
_ASSUMPTION_STATUS = ("open", "confirmed", "corrected")
_AWAITING = re.compile(r"awaiting \S.*")  # intent only a named person can confirm; allowed while Approved


@rule("assumption-indexed", description="Checks that every ASSUMPTION marker carries an A-nn ID with a row in the section 12 index, that each row's status is open, confirmed, corrected or awaiting a named person, and that none is open while the PRD is Approved. Add the ID or the row, or settle the assumption and update its status.")
def assumption_indexed(prd: Prd):
    rows = {r.cells[0].strip("`"): r for r in prd.assumptions if r.cells}
    for rel, n, text in all_lines(prd):
        for m in _MARKER.finditer(text):
            if not m.group(1):
                yield Finding(rel, n, "assumption-indexed", "[ASSUMPTION] marker has no A-nn id")
            elif m.group(1) not in rows:
                yield Finding(rel, n, "assumption-indexed", f"{m.group(1)} has no row in section 12")
    for aid, r in rows.items():
        status = r.cells[2].strip("`") if len(r.cells) > 2 else ""
        if status not in _ASSUMPTION_STATUS and not _AWAITING.fullmatch(status):
            yield Finding("prd.md", r.line, "assumption-indexed", f"{aid}: status '{status}' must be open, confirmed, corrected or awaiting <who>")
        elif status == "open" and _status(prd) == "Approved":
            yield Finding("prd.md", r.line, "assumption-indexed", f"{aid} is open while the PRD is Approved")


@rule("open-questions-empty", description="Checks that section 13 is the single line None. when the PRD is Approved. Answer each open question in the PRD, then replace the list with None.")
def open_questions_empty(prd: Prd):
    if _status(prd) != "Approved":
        return
    sec = next((s for s in prd.sections if s.number == 13), None)
    for n, text in sec.body if sec else []:
        if text.strip() and text.strip() != "None.":
            yield Finding("prd.md", n, "open-questions-empty", "section 13 must be 'None.' when the PRD is Approved")
            return
    if sec and not any(text.strip() for _, text in sec.body):
        yield Finding("prd.md", sec.line, "open-questions-empty", "section 13 must be 'None.' when the PRD is Approved")


@rule("glossary-synonym", description="Checks prose for a word the section 3 glossary lists as a banned synonym of a term. Use the glossary's term instead.")
def glossary_synonym(prd: Prd):
    s3 = next((s for s in prd.sections if s.number == 3), None)
    if not s3:
        return
    skip = {s3.line} | {n for n, _ in s3.body}
    banned: list[tuple[str, re.Pattern]] = []
    for t in tables(s3.body):
        for r in t.rows:
            if len(r.cells) < 3:
                continue
            for word in (w.strip().strip("`") for w in r.cells[2].split(",")):
                if word and word.lower() not in ("-", "—", "none"):
                    banned.append((r.cells[0], re.compile(rf"\b{re.escape(word)}s?\b", re.I)))
    for rel, n, text in _visible_prose(prd):
        if rel == "prd.md" and n in skip:
            continue
        for term, pat in banned:
            m = pat.search(text)
            if m:
                yield Finding(rel, n, "glossary-synonym", f"'{m.group(0)}' is a banned synonym; use '{term}'")
