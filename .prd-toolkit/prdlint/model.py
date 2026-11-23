"""Load a PRD folder into a Prd model. Parsing only; rules live elsewhere."""
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .cardcontext import TARGET_URL, well_formed
from .findings import Finding
from .markdown import Row, Section, frontmatter, sections, strip_code, tables
from .yamlload import LineDict, load_yaml


class NotAPrd(Exception):
    """The folder has no prd.md."""


@dataclass
class Ac:
    id: str
    text: str  # the criterion, without any "(removed in X.Y.Z)" prefix
    line: int
    removed: bool = False  # written "- AC-nnn.n (removed in X.Y.Z) <original text>"


@dataclass
class ReqBlock:
    id: str
    kind: str  # UJ | FR | NFR
    title: str
    file: str
    line: int
    status: str | None = None
    since: str | None = None
    acs: list[Ac] = field(default_factory=list)
    tests: list[tuple[str, str, int]] = field(default_factory=list)  # (T-id, level, line)
    tests_file: str | None = None
    source: str | None = None  # text after "Source:", the code location an as-built block was read from
    errors: list[tuple[str, int]] = field(default_factory=list)  # (code, line)
    lines: list[tuple[int, str]] = field(default_factory=list)  # body lines, heading excluded


@dataclass
class IndexRow:
    id: str
    title: str
    status: str
    file: str
    since: str
    line: int


@dataclass
class TestCase:
    __test__ = False  # not a pytest class
    id: str
    file: str
    line: int
    data: LineDict


ADOPTION_FILE = "adoption.md"
GATES = ("build", "deploy")
GATE_MIGRATION = "testing.md Levels: add a Gate column (build or deploy), new in prd-toolkit 0.4"
UNMIGRATED = (f'section 8: the adoption map moved to {ADOPTION_FILE} in prd-toolkit 0.3; '
              f'move the table there and leave "See {ADOPTION_FILE}."')
ADOPTION_STATES = ("not started", "extracted", "confirmed", "adopted")


@dataclass
class AdoptionRow:
    area: str
    state: str
    boundary: list[str]  # the backticked globs of the Boundary cell
    line: int


@dataclass
class ErrorEntry:
    id: str
    line: int
    open: bool
    touches: list[tuple[str, int]] = field(default_factory=list)  # (requirement ID, line) from `Touches:`
    classification: str = ""  # the trimmed value after `Classification:`; empty when absent
    end: int = 0  # last line of the entry
    title: str = ""
    detected: str = ""  # the trimmed value after `Detected:`; empty when absent
    detected_line: int = 0
    confirmed: tuple[str, str] | None = None  # (date, reply) of a well-formed `Confirmed:`
    confirmed_raw: str | None = None  # the value after `Confirmed:`, well-formed or not; None when the line is absent
    confirmed_line: int = 0
    evidence: list[str] = field(default_factory=list)  # the Evidence lines, continuation prefix stripped
    evidence_line: int = 0
    diagnosis: str = ""
    resolution: str = ""
    resolution_line: int = 0
    recurrence: str = ""
    recurrence_line: int = 0
    classification_line: int = 0
    touches_line: int = 0  # the last `Touches:` line, `Touches: -` included; 0 when absent
    url: str | None = None  # the trimmed value of the entry's first column-0 `URL:` line; None when it has none
    url_line: int = 0

    @property
    def state(self) -> str:
        if not self.open:
            return "resolved"
        if self.classification in ("", "unclassified"):
            return "unclassified"
        return "confirmed" if self.confirmed else "proposed"


@dataclass
class Harness:
    slots: list[tuple[str, int]] = field(default_factory=list)  # (slot name, line) in file order
    test_roots: list[str] | None = None  # the backticked list right after "Test roots:"; None when the text is absent
    test_roots_line: int = 0


@dataclass
class Testing:
    levels: dict[str, int] = field(default_factory=dict)
    gates: dict[str, str] = field(default_factory=dict)
    commands: dict[str, str] = field(default_factory=dict)  # level -> first backticked span of its Harness command cell
    command_cells: dict[str, str] = field(default_factory=dict)  # level -> raw Harness command cell
    has_gate: bool = False
    levels_line: int = 0
    level_envs: dict[str, str] = field(default_factory=dict)  # level -> Environment cell
    timeouts: dict[str, str] = field(default_factory=dict)  # level -> raw Timeout cell (whitespace removed); only when the column exists
    one_tests: dict[str, str] = field(default_factory=dict)  # level -> raw One test cell (whitespace removed); only when the column exists
    environments: dict[str, int] = field(default_factory=dict)
    fixtures: dict[str, int] = field(default_factory=dict)
    signoffs: list[Row] = field(default_factory=list)
    harness: Harness = field(default_factory=Harness)


@dataclass
class Step:
    number: int
    title: str
    actor: str | None  # agent | human; None when the step line does not match the grammar
    env: str | None
    line: int
    labels: dict[str, tuple[str, int]] = field(default_factory=dict)  # Run | Check | Rollback | Do -> (raw value, line)
    repeated: list[tuple[str, int]] = field(default_factory=list)  # (label, line) of each label after its first; the first is used
    run: str | None = None  # the unwrapped backticked command of Run
    tests: list[str] | None = None  # the levels of a `Run: tests <level>[, <level>]` step
    check: str | None = None
    prints: str | None = None
    matches: str | None = None  # the pattern of `Check: `cmd` matches `pattern``
    rollback: str | None = None


@dataclass
class DeployedRow:
    env: str
    version: str
    commit: str
    date: str
    run: str
    line: int


@dataclass
class DriftRow:
    env: str
    check: str
    command: str | None  # the backticked introspection command; None when the cell has none
    line: int


@dataclass
class Operations:
    environments: dict[str, int] = field(default_factory=dict)  # environment -> row line
    production: dict[str, str] = field(default_factory=dict)  # environment -> raw Production cell
    has_production: bool = False  # the Environments table has a Production column
    branches: dict[str, str] = field(default_factory=dict)  # environment -> Branch cell, whitespace and backticks removed; only when the column exists
    steps: list[Step] = field(default_factory=list)
    runbook_line: int = 0
    deployed: list[DeployedRow] = field(default_factory=list)
    drift: list[DriftRow] = field(default_factory=list)
    secrets: list[str] = field(default_factory=list)


LINKS_FILE = "links.md"
UPSTREAM_DIR = "contracts/upstream"
CHANGES_DIR = "changes"
SLUG = re.compile(r"[a-z][a-z0-9-]*")
CROSSING = ("op", "table", "event", "job")
STATES = ("proposed", "approved", "built", "verified")  # then `live in <env>`


@dataclass
class LinkRow:
    name: str
    location: str
    line: int
    version: str = ""
    commit: str = ""
    needs: str = ""


@dataclass
class Links:
    upstreams: list[LinkRow]
    consumers: list[LinkRow]
    headings: dict[str, int]  # "# Links", "## Upstreams", "## Consumers" -> line; a missing one is absent


@dataclass
class SnapshotFile:
    rel: str  # relative to the PRD folder
    header: dict[str, str] | None  # prd, version, commit, and type or dialect when present; None without a header
    text: str  # the file without its header line
    data: Any  # the YAML mapping of a .yaml file, else None


@dataclass
class ChangeRow:
    order: str
    prd: str
    location: str
    branch: str
    version: str
    ids: str
    waits_for: str
    target: str
    state: str
    line: int


@dataclass
class ChangeSet:
    id: str
    file: str
    title: str
    line: int
    started: str = ""  # the text after "Started:"
    status: str = ""  # the text after "Status:"
    approvals: list[str] = field(default_factory=list)  # the text after each "Approval:"
    rows: list[ChangeRow] = field(default_factory=list)
    log: list[str] = field(default_factory=list)  # the Log bullets, "- " stripped
    merge_order: list[str] = field(default_factory=list)  # each "N. " line, number stripped
    problems: list[tuple[int, str]] = field(default_factory=list)  # grammar faults (line, message)


@dataclass
class PackRef:
    name: str
    version: str | None  # None only for the service default, which is not locked
    source: str  # prd-toolkit, or <plugin>@<marketplace>
    file: str  # the PRD-relative file that names it; "" for the default
    line: int


@dataclass
class Target:
    area: str  # the features file stem
    file: str
    line: int
    pack: PackRef | None  # None: inherits section 1
    output_language: str | None  # None: inherits section 1
    url: str | None = None  # FR-065: the address of the line's url part; None without one


@dataclass
class Prd:
    root: Path
    frontmatter: dict[str, str]
    frontmatter_line: int
    docs: dict[str, str]
    sections: list[Section]
    blocks: list[ReqBlock]
    index: list[IndexRow]
    test_cases: list[TestCase]
    yaml: dict[str, Any]
    testing: Testing
    not_applicable: dict[str, tuple[str, int]]
    assumptions: list[Row]
    load_findings: list[Finding]
    adoption: list[AdoptionRow] | None = None  # None exactly when adoption.md is absent
    adoption_unmigrated: bool = False  # a 0.2 PRD: §8 still holds the table and adoption.md is absent
    errors_ledger: dict[str, ErrorEntry] = field(default_factory=dict)
    operations: Operations = field(default_factory=Operations)
    links: Links | None = None  # None exactly when links.md is absent
    snapshots: dict[str, list[SnapshotFile]] = field(default_factory=dict)  # upstream folder -> files
    change_sets: dict[str, ChangeSet] = field(default_factory=dict)
    pack_ref: PackRef | None = None  # section 1's `- Pack:` line; None means the service default
    output_language: tuple[str, int] | None = None  # section 1's `- Output language:` (code, line)
    targets: dict[str, Target] = field(default_factory=dict)  # area -> its well-formed `Target:` line
    profile_problems: list[tuple[str, int, str]] = field(default_factory=list)  # (file, line, message)


_HEADING = re.compile(r"^#{1,3}\s")
_BLOCK = re.compile(r"^### ((?:UJ-\d+)|(?:FR-\d+)|(?:NFR-\d+))\s+(.*?)\s*$")
_STATUS = re.compile(r"^Status:\s*(.*?)\s*(?:\(since\s+([^)]*)\))?\s*$")
_AC = re.compile(r"^- (AC-\d+\.\d+)\s+(.*)$")
_AC_REMOVED = re.compile(r"^\(removed in \d+\.\d+\.\d+\)\s*")
_TEST = re.compile(r"(T-\d+\.\d+)\s*\[([^\]]+)\]")
_NA = re.compile(r"^\s*[-*]\s*Not applicable:\s*`([^`]+)`\s+[—–-]+\s+(.*?)\s*$")
_ERROR_HEAD = re.compile(r"^### (E-\d+)\b")
_RESOLUTION = re.compile(r"^Resolution:\s*(.*?)\s*$")
_TOUCHES = re.compile(r"^Touches:\s*(.*?)\s*$")
_CLASSIFICATION = re.compile(r"^Classification:\s*(.*?)\s*$")
_DETECTED = re.compile(r"^Detected:\s*(.*?)\s*$")
_CONFIRMED = re.compile(r"^Confirmed:\s*(.*?)\s*$")
_CONFIRMED_VALUE = re.compile(r'^(\d{4}-\d{2}-\d{2}),\s*"(.*)"$')
_EVIDENCE = re.compile(r"^Evidence:\s*(.*?)\s*$")
_DIAGNOSIS = re.compile(r"^Diagnosis:\s*(.*?)\s*$")
_RECURRENCE = re.compile(r"^Recurrence of:\s*(.*?)\s*$")
_URL = re.compile(r"^URL:(.*)$")
CLASSES = ("code bug", "spec gap", "invalid requirement", "environment", "standard", "unclassified")
DRIFT_CHECKS = ("version", "config")
_TOUCH_ID = re.compile(r"\b(?:UJ|FR|NFR)-\d+\b")
_SLOT = re.compile(r"^- \*\*([^*]+?)\.\*\*")
_MARKER = re.compile(r"\[NEEDS CLARIFICATION:[^\]]*\]")
_BACKTICKED = re.compile(r"`([^`]+)`")
_ITEM_LIST = re.compile(r"\s*(`[^`]+`(?:\s*,\s*`[^`]+`)*)")  # a comma-separated run of backticked items


def _field_lines(lines: list[tuple[int, str]], name: str) -> list[tuple[int, str]]:
    """The `name:` line of a block plus its indented continuation lines, as (line, text)."""
    out: list[tuple[int, str]] = []
    for i, (n, text) in enumerate(lines):
        if text.startswith(name + ":"):
            out.append((n, text[len(name) + 1 :].strip()))
            for n2, t2 in lines[i + 1 :]:
                if t2.startswith("  ") and t2.strip():
                    out.append((n2, t2.strip()))
                else:
                    break
            break
    return out


def _parse_block(m: re.Match, rel: str, n: int, body: list[tuple[int, str]]) -> ReqBlock:
    b = ReqBlock(m.group(1), m.group(1).split("-")[0], m.group(2), rel, n, lines=body)
    for _, text in _field_lines(body, "Status")[:1]:
        sm = _STATUS.match("Status: " + text)
        b.status, b.since = sm.group(1) or None, sm.group(2)
    # acceptance criteria: "- AC-nnn.n text" plus continuation lines indented two or more spaces
    cur: Ac | None = None
    for ln, text in body:
        am = _AC.match(text)
        if am:
            ac_text, n_removed = _AC_REMOVED.subn("", am.group(2).strip(), count=1)
            cur = Ac(am.group(1), ac_text, ln, removed=bool(n_removed))
            b.acs.append(cur)
        elif cur and text.startswith("  ") and text.strip():
            cur.text += " " + text.strip()
        else:
            cur = None
    for ln, text in _field_lines(body, "Errors"):  # continuation lines included
        head, paren, _ = text.partition("(")
        for code in (c.strip() for c in head.split(",")):
            if re.fullmatch(r"[A-Z][A-Z0-9_]*", code):
                b.errors.append((code, ln))
        if paren:  # the parenthetical closes the code list
            break
    sl = _field_lines(body, "Source")
    b.source = " ".join(t for _, t in sl) or None
    tl = _field_lines(body, "Tests")
    for ln, text in tl:
        for tid, level in _TEST.findall(text):
            b.tests.append((tid, level.strip(), ln))
    fm = re.search(r"\((test-cases/[^)\s]+)\)", " ".join(t for _, t in tl))
    b.tests_file = fm.group(1) if fm else None
    return b


def _blocks_in(rel: str, text: str) -> list[ReqBlock]:
    lines = text.split("\n")
    stripped = strip_code(text).split("\n")
    blocks: list[ReqBlock] = []
    cur: tuple[re.Match, int] | None = None
    body: list[tuple[int, str]] = []

    def close():
        if cur:
            blocks.append(_parse_block(cur[0], rel, cur[1], body))

    for n, (orig, st) in enumerate(zip(lines, stripped), 1):
        if _HEADING.match(st):
            close()
            m = _BLOCK.match(orig) if _BLOCK.match(st) else None
            cur, body = ((m, n) if m else None), []
            continue
        if cur:
            body.append((n, orig))
    close()
    return blocks


def _table_under(secs: list[Section], title: str):
    for s in secs:
        if s.title.strip().lower() == title.lower():
            ts = tables(s.body)
            return ts[0] if ts else None
    return None


def _names(table) -> dict[str, int]:
    return {r.cells[0].strip("`"): r.line for r in table.rows} if table else {}


def _adoption(docs: dict[str, str]) -> list[AdoptionRow] | None:
    """Rows of the first table in adoption.md; None when the file is absent, [] when it has no table."""
    if ADOPTION_FILE not in docs:
        return None
    ts = tables([(n, line) for n, line in enumerate(docs[ADOPTION_FILE].split("\n"), 1)])
    rows = []
    for r in ts[0].rows if ts else []:
        c = r.cells + [""] * 3
        rows.append(AdoptionRow(c[0].strip("`"), c[1].strip("`"), _BACKTICKED.findall(c[2]), r.line))
    return rows


def _errors_ledger(text: str) -> dict[str, ErrorEntry]:
    """`### E-nnn` entries of errors.md; open unless a Resolution line carries a real value."""
    ledger: dict[str, ErrorEntry] = {}
    cur: ErrorEntry | None = None
    last = len(text.rstrip("\n").split("\n")) if text.strip() else 0
    in_evidence = False
    for n, (orig, st) in enumerate(zip(text.split("\n"), strip_code(text).split("\n")), 1):
        if _HEADING.match(st):
            if cur:
                cur.end = n - 1
            in_evidence = False
            m = _ERROR_HEAD.match(orig) if _ERROR_HEAD.match(st) else None
            cur = ErrorEntry(m.group(1), n, True, title=orig[m.end():].strip()) if m else None
            if cur:
                ledger.setdefault(cur.id, cur)
            continue
        if cur and in_evidence and orig.startswith("  "):
            cur.evidence.append(orig[2:].rstrip())
            continue
        in_evidence = False
        rm = _RESOLUTION.match(orig) if cur else None
        if rm:
            v = rm.group(1).lower()
            cur.open = v in ("", "-") or v.startswith("open")
            cur.resolution, cur.resolution_line = rm.group(1), n
        cm = _CLASSIFICATION.match(orig) if cur else None
        if cm:
            cur.classification, cur.classification_line = cm.group(1), n
        for rx, attr in ((_DETECTED, "detected"), (_DIAGNOSIS, "diagnosis"), (_RECURRENCE, "recurrence")):
            fm = rx.match(orig) if cur else None
            if fm:
                setattr(cur, attr, fm.group(1))
                if attr in ("detected", "recurrence"):
                    setattr(cur, attr + "_line", n)
        fm = _CONFIRMED.match(orig) if cur else None
        if fm:
            cur.confirmed_raw, cur.confirmed_line = fm.group(1), n
            vm = _CONFIRMED_VALUE.match(fm.group(1))
            cur.confirmed = (vm.group(1), vm.group(2)) if vm else None
        em = _EVIDENCE.match(orig) if cur else None
        if em:
            cur.evidence_line, cur.evidence, in_evidence = n, ([em.group(1)] if em.group(1) else []), True
        tm = _TOUCHES.match(orig) if cur else None
        if tm:
            cur.touches.extend((i, n) for i in _TOUCH_ID.findall(tm.group(1)))
            cur.touches_line = n
        um = _URL.match(orig) if cur and cur.url is None else None
        if um:  # FR-063: the first column-0 URL: line of the entry, wherever it stands
            cur.url, cur.url_line = um.group(1).strip(), n
    for e in ledger.values():
        e.end = e.end or last
    return ledger


_STEP_LINE = re.compile(r"^(\d+)\.\s+(.*?)\s*\(actor:\s*(agent|human)\)\s*\(env:\s*`?([^`)]+?)`?\)\s*$")
_STEP_ANY = re.compile(r"^(\d+)\.\s+(.*?)\s*$")
_LABEL = re.compile(r"^\s+(Run|Check|Rollback|Do):\s*(.*?)\s*$")
_CMD = re.compile(r"^`([^`]+)`$")
_CHECK = re.compile(r"^`([^`]+)`((?:\s+(?:prints|matches)\s+`[^`]*`)*)$")
_CHECK_TAIL = re.compile(r"\s+(prints|matches)\s+`([^`]*)`")
_TESTS = re.compile(r"^tests\s+(.+)$")
_SECRET_NAME = re.compile(r"[A-Z][A-Z0-9_]*")


def _step(m: re.Match, n: int, body: list[tuple[int, str]]) -> Step:
    full = _STEP_LINE.match(m.group(0))
    s = Step(int(full.group(1) if full else m.group(1)), (full or m).group(2), full.group(3) if full else None,
             full.group(4).strip() if full else None, n)
    for ln, text in body:
        lm = _LABEL.match(text)
        if lm:
            if lm.group(1) in s.labels:
                s.repeated.append((lm.group(1), ln))
            else:
                s.labels[lm.group(1)] = (lm.group(2), ln)
    if "Run" in s.labels:
        raw = s.labels["Run"][0]
        tm = _TESTS.match(raw)
        cm = _CMD.match(raw)
        if tm:
            s.tests = [x.strip() for x in tm.group(1).split(",") if x.strip()]
        elif cm:
            s.run = cm.group(1).strip()
    if "Check" in s.labels:
        km = _CHECK.match(s.labels["Check"][0])
        if km:
            tails = _CHECK_TAIL.findall(km.group(2))
            kinds = [k for k, _ in tails]
            if len(set(kinds)) == len(kinds):  # each form at most once; a repeat is malformed
                s.check = km.group(1).strip()
                for k, v in tails:
                    setattr(s, k, v)
    if "Rollback" in s.labels:
        cm = _CMD.match(s.labels["Rollback"][0])
        if cm:
            s.rollback = cm.group(1).strip()
    return s


def _operations(text: str) -> Operations:
    ops = Operations()
    secs = sections(text)
    env = _table_under(secs, "Environments")
    if env:
        hdr = [h.strip().strip("`").lower() for h in env.header]
        pi = hdr.index("production") if "production" in hdr else -1
        ops.has_production = pi >= 0
        ops.environments = _names(env)
        if pi >= 0:
            for r in env.rows:
                ops.production[r.cells[0].strip("`")] = (r.cells[pi] if pi < len(r.cells) else "").strip().strip("`").strip()
        if "branch" in hdr:
            bi = hdr.index("branch")
            for r in env.rows:
                ops.branches[r.cells[0].strip("`")] = (r.cells[bi] if bi < len(r.cells) else "").strip().replace("`", "").strip()
    for s in secs:
        title = s.title.strip().lower()
        if title == "runbook":
            ops.runbook_line = s.line
            stripped = strip_code("\n".join(t for _, t in s.body)).split("\n")
            cur: tuple[re.Match, int] | None = None
            body: list[tuple[int, str]] = []
            for (n, orig), st in zip(s.body, stripped):
                m = _STEP_ANY.match(orig) if re.match(r"^\d+\.\s", st) else None
                if m:
                    if cur:
                        ops.steps.append(_step(cur[0], cur[1], body))
                    cur, body = (m, n), []
                elif cur:
                    body.append((n, orig))
            if cur:
                ops.steps.append(_step(cur[0], cur[1], body))
        elif title == "deployed":
            ts = tables(s.body)
            for r in ts[0].rows if ts else []:
                c = [x.strip().strip("`") for x in r.cells] + [""] * 5
                ops.deployed.append(DeployedRow(c[0], c[1], c[2], c[3], c[4], r.line))
        elif title == "drift":
            ts = tables(s.body)
            for r in ts[0].rows if ts else []:
                c = r.cells + [""] * 3
                cm = re.search(r"`([^`]+)`", c[2])
                ops.drift.append(DriftRow(c[0].strip("`"), c[1].strip("`").strip(), cm.group(1).strip() if cm else None, r.line))
        elif title == "secrets":
            for _, text_ in s.body:
                bm = re.match(r"^\s*[-*]\s+(.*)$", text_)
                if bm:
                    for name in (x.strip() for x in bm.group(1).split(":", 1)[0].split(",")):
                        if _SECRET_NAME.fullmatch(name):
                            ops.secrets.append(name)
    return ops


def production_envs(prd: Prd) -> set[str]:
    """The environments whose Production cell is `yes`."""
    return {e for e, v in prd.operations.production.items() if v == "yes"}


def _harness(body: list[tuple[int, str]]) -> Harness:
    h = Harness()
    for n, text in body:
        m = _SLOT.match(text)
        if not m:
            continue
        h.slots.append((m.group(1), n))
        if m.group(1) == "Layout" and "Test roots:" in text:
            tail = _MARKER.sub("", text.split("Test roots:", 1)[1])
            lst = _ITEM_LIST.match(tail)  # stops at the first text that is not another ", `item`"
            h.test_roots, h.test_roots_line = (_BACKTICKED.findall(lst.group(1)) if lst else []), n
    return h


def parse_ref(ref: str) -> tuple[str, str | None, str]:
    """`<kind>:<name>` -> (kind, prefix, name); `<kind>:<a>/<b>` carries the prefix `a` when it is a slug and the kind is not code."""
    kind, _, rest = ref.partition(":")
    head, slash, tail = rest.partition("/")
    if slash and kind != "code" and SLUG.fullmatch(head):
        return kind, head, tail
    return kind, None, rest


def ref_prefix(prd: "Prd", ref: str) -> str | None:
    """The upstream prefix of `ref` in a PRD that has links.md; None without one, where every reference is judged as
    before 0.7 (R-10c: a PRD without links.md needs no edit)."""
    return parse_ref(ref)[1] if prd.links is not None else None


def _links(text: str) -> Links:
    out = Links([], [], {})
    for n, line in enumerate(strip_code(text).split("\n"), 1):
        h = line.strip()
        if h in ("# Links", "## Upstreams", "## Consumers"):
            out.headings.setdefault(h, n)
    for s in sections(text):
        title = s.title.strip().lower()
        if title not in ("upstreams", "consumers"):
            continue
        ts = tables(s.body)
        for r in ts[0].rows if ts else []:
            c = [x.strip() for x in r.cells] + [""] * 5
            name = c[0].strip("`")
            if title == "upstreams":
                out.upstreams.append(LinkRow(name, c[1], r.line, c[2], c[3], c[4]))
            else:
                out.consumers.append(LinkRow(name, c[1], r.line))
    return out


_SNAP_HEADER = re.compile(
    r"^(?:-- |# |<!-- )Snapshot of (?P<prd>\S+) (?P<version>\S+) at (?P<commit>\S+), written by prd_links\.py sync\. Do not edit\."
    r"(?: Type: (?P<type>[^\s.]+)\.)?(?: Dialect: (?P<dialect>[^\s.]+)\.)?(?: -->)?$")


def _snapshots(prd_dir: Path, findings: list[Finding]) -> dict[str, list[SnapshotFile]]:
    out: dict[str, list[SnapshotFile]] = {}
    base = prd_dir / UPSTREAM_DIR
    if not base.is_dir():
        return out
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        files = []
        for p in sorted(x for x in d.rglob("*") if x.is_file() and not any(part.startswith(".") for part in x.relative_to(d).parts)):
            rel = p.relative_to(prd_dir).as_posix()
            try:
                raw = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                findings.append(Finding(rel, 0, "snapshot-cited", f"{rel}: not a readable UTF-8 snapshot file"))
                files.append(SnapshotFile(rel, None, "", None))
                continue
            first, nl, rest = raw.partition("\n")
            m = _SNAP_HEADER.match(first.rstrip())
            header = {k: v for k, v in m.groupdict().items() if v} if m else None
            text = rest if m else raw
            data = None
            if p.suffix == ".yaml":
                data, fs = load_yaml(p, rel)
                findings += fs
            files.append(SnapshotFile(rel, header, text, data))
        out[d.name] = files
    return out


_CS_FILE = re.compile(r"CS-\d{3}\.md")
_CS_TITLE = re.compile(r"^# (CS-\d{3}) (\S.*?)\s*$")
_CS_STARTED = re.compile(r"^\d{4}-\d{2}-\d{2} in [a-z][a-z0-9-]*$")
_CS_STATUS = re.compile(r"^(?:proposed|approved|running|done|abandoned|stopped: [a-z][a-z0-9-]*: \S.*)$")
_CS_APPROVAL = re.compile(r'^\d{4}-\d{2}-\d{2}, ".*"(?: \(amendment\))?$')
_CS_HEADER = ["Order", "PRD", "Location", "Branch", "Version", "IDs", "Waits for", "Target", "State"]
_CS_VERSION = re.compile(r"^\d+\.\d+\.\d+(?: → \d+\.\d+\.\d+)?$")
_CS_IDS = re.compile(r"^(?:—|(?:UJ|FR|NFR)-\d+(?:, ?(?:UJ|FR|NFR)-\d+)*)$")
_CS_WAIT = re.compile(r"^[a-z][a-z0-9-]* (?:verified|live in \S.*)$")
_CS_STATE = re.compile(r"^(?:proposed|approved|built|verified|live in \S.*)$")
_CS_LOG = re.compile(r"^- \d{4}-\d{2}-\d{2} \S")
_CS_MERGE = re.compile(r"^(\d+)\. ([a-z][a-z0-9-]*) \(\S+\)$")


def _change_set(rel: str, text: str) -> ChangeSet:
    cs = ChangeSet(Path(rel).stem, rel, "", 1)
    bad = cs.problems
    lines = text.split("\n")
    stripped = strip_code(text).split("\n")
    tm = _CS_TITLE.match(lines[0]) if lines else None
    if tm and tm.group(1) == cs.id:
        cs.title = tm.group(2)
    else:
        bad.append((1, f"the first line must be `# {cs.id} <title>`"))
        cs.title = lines[0].lstrip("# ").strip() if lines else ""
    for n, (orig, st) in enumerate(zip(lines, stripped), 1):
        if n == 1 or not st.strip():
            continue
        if orig.startswith("Started:"):
            cs.started = orig[8:].strip()
            if not _CS_STARTED.match(cs.started):
                bad.append((n, "Started must read `YYYY-MM-DD in <prd>`"))
        elif orig.startswith("Status:"):
            cs.status = orig[7:].strip()  # its grammar is the change-sets rule's to report, once
        elif orig.startswith("Approval:"):
            v = orig[9:].strip()
            cs.approvals.append(v)
            if not _CS_APPROVAL.match(v):
                bad.append((n, 'Approval must read `YYYY-MM-DD, "<reply>"`, then optionally ` (amendment)`'))
    for s in sections(text, 2):
        title = s.title.strip().lower()
        if title == "log":
            for n, orig in s.body:
                if orig.strip():
                    if _CS_LOG.match(orig):
                        cs.log.append(orig[2:].strip())
                    else:
                        bad.append((n, "a Log line must read `- YYYY-MM-DD <text>`"))
        elif title == "merge order":
            for n, orig in s.body:
                if orig.strip():
                    m = _CS_MERGE.match(orig.strip())
                    if m:
                        cs.merge_order.append(orig.strip().split(". ", 1)[1])
                    else:
                        bad.append((n, "a Merge order line must read `N. <prd> (<branch>)`"))
    first2 = next((s.line for s in sections(text, 2)), len(lines) + 1)
    ts = tables([(n, t) for n, t in enumerate(lines, 1) if 1 < n < first2])
    if not ts:
        bad.append((1, "the record has no table"))
        return cs
    t = ts[0]
    if [h.strip() for h in t.header] != _CS_HEADER:
        bad.append((t.line, "the table header must be `" + " | ".join(_CS_HEADER) + "`"))
    for r in t.rows:
        if len(r.cells) != 9:
            bad.append((r.line, f"a row has {len(r.cells)} cells, not 9"))
            continue
        c = [x.strip() for x in r.cells]
        cs.rows.append(ChangeRow(*c, line=r.line))
        for name, val, rx in (("Version", c[4], _CS_VERSION), ("IDs", c[5], _CS_IDS)):  # Target and State: the rule's
            if not rx.match(val):
                bad.append((r.line, f"{name} `{val}` is malformed"))
        if c[6] != "—" and not all(_CS_WAIT.match(w.strip()) for w in c[6].split(";")):
            bad.append((r.line, f"Waits for `{c[6]}` is malformed"))
    return cs


def _change_sets(prd_dir: Path) -> dict[str, ChangeSet]:
    d = prd_dir / CHANGES_DIR
    out: dict[str, ChangeSet] = {}
    for p in sorted(d.glob("*.md")) if d.is_dir() else []:
        if _CS_FILE.fullmatch(p.name) and p.is_file():  # a non-file entry is a sufficiency finding of load (AC-006.3)
            rel = p.relative_to(prd_dir).as_posix()
            out[p.stem] = _change_set(rel, p.read_text(encoding="utf-8"))
    return out


def _linked_dir(prd_dir: Path, p: Path) -> bool:
    """A file under contracts/upstream/ or changes/ of a PRD with links.md (R-10c): kept out of docs and yaml. Without
    links.md those folders load as any other."""
    rel = p.relative_to(prd_dir).as_posix()
    return rel.startswith((UPSTREAM_DIR + "/", CHANGES_DIR + "/")) and (prd_dir / LINKS_FILE).is_file()


_PACK_VALUE = re.compile(r"([a-z][a-z0-9-]*) (\d+\.\d+\.\d+) \((prd-toolkit|[^\s()@]+@[^\s()@]+)\)")
_LANG_TAG = re.compile(r"[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*")
_S1_PACK = re.compile(r"^- Pack:(.*)$")
_S1_OUTPUT = re.compile(r"^- Output language:(.*)$")
_TARGET_LINE = re.compile(r"^Target:(.*)$")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
PACK_GRAMMAR = "Pack: must be <name> <X.Y.Z> (<source>)"
OUTPUT_GRAMMAR = "Output language: must be a BCP 47 tag such as es or pt-BR"
TARGET_GRAMMAR = ("Target: must be one or more of pack <name> <X.Y.Z> (<source>), output language <code> and url <address>, "
                  "comma-separated, in that order")
TARGET_PLACE = "Target: must come before the first requirement"
TARGET_ABOVE = "Target: must come after the file's level-1 heading"


def _masked(text: str) -> list[str]:
    """Lines with fenced code, inline code and HTML comments blanked; line numbers survive."""
    return _COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), strip_code(text)).split("\n")


def _pack_ref(value: str, rel: str, n: int) -> PackRef | None:
    m = _PACK_VALUE.fullmatch(value.strip())
    return PackRef(m.group(1), m.group(2), m.group(3), rel, n) if m else None


def _section_1_profile(s1: Section | None, problems: list) -> tuple[PackRef | None, tuple[str, int] | None]:
    pack: PackRef | None = None
    output: tuple[str, int] | None = None
    first: dict[str, int] = {}
    if not s1:
        return pack, output
    for (n, orig), st in zip(s1.body, _masked("\n".join(t for _, t in s1.body))):
        for label, rx in (("Pack", _S1_PACK), ("Output language", _S1_OUTPUT)):
            m = rx.match(orig) if rx.match(st) else None
            if not m:
                continue
            if label in first:
                problems.append(("prd.md", n, f"{label}: repeated (first at line {first[label]}); one {label}: line per PRD"))
                continue
            first[label] = n
            value = m.group(1).strip()
            if label == "Pack":
                pack = _pack_ref(value, "prd.md", n)
                if pack is None:
                    problems.append(("prd.md", n, PACK_GRAMMAR))
            elif _LANG_TAG.fullmatch(value):
                output = (value, n)
            else:
                problems.append(("prd.md", n, OUTPUT_GRAMMAR))
    return pack, output


def _target_value(value: str, rel: str, n: int) -> tuple[PackRef | None, str | None, str | None] | str:
    """The pack, output-language and url parts of a `Target:` value (FR-065), or the message of a malformed one.

    The url part is the line's last part: its address runs to the end of the line, so it may hold a comma."""
    pieces = value.split(",")
    head, address = pieces, None
    for i, piece in enumerate(pieces):
        if piece.strip().startswith("url "):
            head, address = pieces[:i], ",".join(pieces[i:]).strip()[4:].strip()
            break
    pack: PackRef | None = None
    lang: str | None = None
    last = -1  # the position, in AC-065.1's order, of the part before
    for piece in head:
        part = piece.strip()
        if part.startswith("pack ") and last < 0:
            pack, last = _pack_ref(part[5:], rel, n), 0
            if pack is None:
                return TARGET_GRAMMAR
        elif part.startswith("output language ") and last < 1 and _LANG_TAG.fullmatch(part[16:].strip()):
            lang, last = part[16:].strip(), 1
        else:
            return TARGET_GRAMMAR
    if address is None:
        return pack, lang, None
    return (pack, lang, address) if well_formed(address) else TARGET_URL


def _targets(docs: dict[str, str], problems: list) -> dict[str, Target]:
    """Each features file's `Target:` line: column 0, after the level-1 heading, before the first level-3 heading."""
    out: dict[str, Target] = {}
    for rel in (r for r in docs if re.fullmatch(r"features/[^/]+\.md", r)):
        area = Path(rel).stem
        masked = _masked(docs[rel])
        h1 = next((n for n, st in enumerate(masked, 1) if st.startswith("# ")), 0)
        seen_h3 = False
        for n, (orig, st) in enumerate(zip(docs[rel].split("\n"), masked), 1):
            if st.startswith("### "):
                seen_h3 = True
            m = _TARGET_LINE.match(orig) if _TARGET_LINE.match(st) else None
            if not m:
                continue
            if seen_h3:
                problems.append((rel, n, TARGET_PLACE))
            elif n < h1:
                problems.append((rel, n, TARGET_ABOVE))
            elif area in out:
                problems.append((rel, n, f"Target: repeated (first at line {out[area].line}); one Target: line per area"))
            else:
                parts = _target_value(m.group(1), rel, n)
                if isinstance(parts, str):
                    problems.append((rel, n, parts))
                    out[area] = None  # the line is taken: a later one is still a repeat
                else:
                    out[area] = Target(area, rel, n, *parts)
    return {a: t for a, t in out.items() if t is not None}


FIXTURES_DIR = "contracts/fixtures"


ROOT_README = "README.md"  # the folder's root guide, written by prd_block.py from the PRD: never a source, never linted (FR-015)


def _fixture(rel: str) -> bool:
    """A path under contracts/fixtures/: fixture data, read neither as a document nor as contract YAML."""
    return rel.startswith(FIXTURES_DIR + "/")


def load(prd_dir: Path) -> Prd:
    prd_dir = Path(prd_dir).resolve()
    # the exact name: on a case-insensitive filesystem `prd.md` also "exists" as PRD.md
    names = {p.name: p for p in prd_dir.iterdir()} if prd_dir.is_dir() else {}
    if "prd.md" in names and names["prd.md"].is_dir():
        raise NotAPrd(f"{prd_dir}: prd.md must be a file")
    if "prd.md" not in names or not names["prd.md"].is_file():
        # the hint names a different entry only: an entry named exactly prd.md that is not a file gets none
        other = next((n for n in names if n.lower() == "prd.md"), None) if "prd.md" not in names else None
        hint = f"; found {other}; the file name is lowercase prd.md" if other else ""
        raise NotAPrd(f"{prd_dir}: no prd.md{hint}")
    findings: list[Finding] = []
    docs: dict[str, str] = {}
    for p in sorted(prd_dir.rglob("*.md")):
        rel = p.relative_to(prd_dir).as_posix()
        if _fixture(rel) or rel == ROOT_README:
            continue
        if not p.is_file():
            findings.append(Finding(rel, 0, "sufficiency", "a .md entry that is not a file"))
            continue
        if not _linked_dir(prd_dir, p):
            docs[rel] = p.read_text(encoding="utf-8")
    fm, fm_line = frontmatter(docs["prd.md"])
    secs = sections(docs["prd.md"])

    blocks: list[ReqBlock] = []
    for rel in [r for r in docs if re.fullmatch(r"features/[^/]+\.md", r)] + (["nfr.md"] if "nfr.md" in docs else []):
        blocks += _blocks_in(rel, docs[rel])

    def sec(num: int):
        return next((s for s in secs if s.number == num), None)

    index: list[IndexRow] = []
    s11 = sec(11)
    for t in tables(s11.body) if s11 else []:
        for r in t.rows:
            c = [x.strip("`") for x in r.cells] + [""] * 5
            index.append(IndexRow(c[0], c[1], c[2], c[3], c[4], r.line))
    assumptions: list[Row] = []
    s12 = sec(12)
    for t in tables(s12.body) if s12 else []:
        assumptions += t.rows
    na: dict[str, tuple[str, int]] = {}
    s1 = sec(1)
    for n, text in s1.body if s1 else []:
        m = _NA.match(text)
        if m:
            na[m.group(1)] = (m.group(2), n)

    test_cases: list[TestCase] = []
    for p in sorted((prd_dir / "test-cases").glob("*.yaml")):
        rel = p.relative_to(prd_dir).as_posix()
        if not p.is_file():
            findings.append(Finding(rel, 0, "sufficiency", "a .yaml entry that is not a file"))
            continue
        data, fs = load_yaml(p, rel)
        findings += fs
        for tid, val in (data or {}).items():
            if not isinstance(val, LineDict):
                findings.append(Finding(rel, data.key_lines[tid], "sufficiency", f"{tid}: a test case must be a mapping"))
                val = LineDict()
                val.line = data.key_lines[tid]
            test_cases.append(TestCase(str(tid), rel, data.key_lines[tid], val))

    yml: dict[str, Any] = {}
    for p in sorted((prd_dir / "contracts").rglob("*.yaml")):
        rel = p.relative_to(prd_dir).as_posix()
        if _fixture(rel):
            continue
        if not p.is_file():
            findings.append(Finding(rel, 0, "sufficiency", "a .yaml entry that is not a file"))
            continue
        if _linked_dir(prd_dir, p):
            continue
        data, fs = load_yaml(p, rel)
        findings += fs
        if data is not None:
            yml[rel] = data

    testing = Testing()
    if "testing.md" in docs:
        tsecs = sections(docs["testing.md"])
        lv = _table_under(tsecs, "Levels")
        testing.levels = _names(lv)
        if lv:
            testing.levels_line = lv.line
            for r in lv.rows:
                cm = re.search(r"`([^`]*)`", r.cells[1]) if len(r.cells) > 1 else None
                testing.command_cells[r.cells[0].strip("`")] = r.cells[1] if len(r.cells) > 1 else ""
                if cm and cm.group(1).strip():
                    testing.commands[r.cells[0].strip("`")] = cm.group(1).strip()
            hdr = [h.strip().strip("`").lower() for h in lv.header]
            gi = hdr.index("gate", 3) if "gate" in hdr[3:] else -1
            testing.has_gate = gi >= 0
            if gi >= 0:
                for r in lv.rows:
                    cell = r.cells[gi] if gi < len(r.cells) else ""
                    testing.gates[r.cells[0].strip("`")] = cell.strip().strip("`").strip()
        if lv:
            hdr = [h.strip().strip("`").lower() for h in lv.header]
            ei = hdr.index("environment") if "environment" in hdr else -1
            if ei >= 0:
                for r in lv.rows:
                    testing.level_envs[r.cells[0].strip("`")] = (r.cells[ei] if ei < len(r.cells) else "").strip().strip("`").strip()
            ti = hdr.index("timeout") if "timeout" in hdr else -1
            if ti >= 0:
                for r in lv.rows:
                    testing.timeouts[r.cells[0].strip("`")] = (r.cells[ti] if ti < len(r.cells) else "").strip()
            oi = next((i for i, h in enumerate(lv.header) if h.strip().strip("`").strip().lower() == "one test"), -1)
            if oi >= 0:  # FR-075: the optional One test column, found by its header name as Timeout is
                for r in lv.rows:
                    testing.one_tests[r.cells[0].strip("`")] = (r.cells[oi] if oi < len(r.cells) else "").strip()
        testing.environments = _names(_table_under(tsecs, "Environments"))
        testing.fixtures = _names(_table_under(tsecs, "Fixtures"))
        so = _table_under(tsecs, "Sign-offs")
        testing.signoffs = so.rows if so else []
        hs = next((x for x in tsecs if x.title.strip().lower() == "harness"), None)
        testing.harness = _harness(hs.body) if hs else Harness()

    s8 = sec(8)
    snapshots = _snapshots(prd_dir, findings) if LINKS_FILE in docs else {}  # R-10c: no links.md, no snapshot
    problems: list[tuple[str, int, str]] = []
    pack_ref, output_language = _section_1_profile(s1, problems)
    targets = _targets(docs, problems)
    return Prd(prd_dir, fm, fm_line, docs, secs, blocks, index, test_cases, yml, testing, na, assumptions, findings,
               adoption=_adoption(docs), operations=_operations(docs.get("operations.md", "")), errors_ledger=_errors_ledger(docs.get("errors.md", "")),
               links=_links(docs[LINKS_FILE]) if LINKS_FILE in docs else None, snapshots=snapshots, change_sets=_change_sets(prd_dir),
               adoption_unmigrated=ADOPTION_FILE not in docs and bool(s8 and tables(s8.body)),
               pack_ref=pack_ref, output_language=output_language, targets=targets, profile_problems=problems)


def gate_of(prd: Prd, level: str) -> str | None:
    """The Gate (build or deploy) of a Levels row; None for an unknown level, a missing column or a blank cell."""
    return prd.testing.gates.get(level) or None


def git_toplevel(path: Path) -> Path | None:
    """`git rev-parse --show-toplevel` from `path`; None when git cannot find a checkout there (or git is missing)."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], cwd=path, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10, check=True
        ).stdout.strip()
        return Path(out) if out else None
    except (OSError, subprocess.SubprocessError):
        return None


def repo_root(path: Path) -> Path:
    """`git rev-parse --show-toplevel` from `path`; `path` itself on any failure (including no git)."""
    return git_toplevel(path) or path
