"""ID and requirement rules: formats, uniqueness, removal, the index, EARS and NFR bounds."""
import re
from collections import defaultdict
from collections.abc import Iterator

from .. import languages
from ..findings import Finding
from ..model import ADOPTION_STATES, IndexRow, Prd, ReqBlock
from ..registry import rule
from .structure import prose

ID_PATTERNS: dict[str, re.Pattern] = {
    "UJ": re.compile(r"UJ-\d{2}"),
    "FR": re.compile(r"FR-\d{3}"),
    "NFR": re.compile(r"NFR-\d{3}"),
    "AC": re.compile(r"AC-\d{3}\.\d+"),
    "T": re.compile(r"T-\d{3}\.\d+"),
    "E": re.compile(r"E-\d{3}"),
    "A": re.compile(r"A-\d{2}"),
}
# requirement statuses; structure.STATUSES holds the PRD's own (Draft, In review, Approved)
REQ_STATUSES = ("as-built", "approved", "built", "verified", "live", "removed")

_TOKEN = re.compile(r"\b(UJ|FR|NFR|AC|T|E|A)-[0-9][0-9.]*\b")
_REQ_ID = re.compile(r"\b(?:UJ-\d+|FR-\d+|NFR-\d+|AC-\d+\.\d+)\b")
_E_HEADING = re.compile(r"^### (E-\d+)\b")
_UNIT = re.compile(r"\d+(\.\d+)?\s*(?:(?:ms|s|sec|seconds?|minutes?|min|h|hrs?|hours?|days?|KB|MB|GB|TB|requests?/s|req/s|requests?/min|req/min|rps|rows|users|errors?)\b|%)")


def defined_ids(prd: Prd) -> dict[str, list[tuple[str, int]]]:
    """Every definition of every ID: block headings, ACs, test-case keys, E- headings, A- rows."""
    out: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for b in prd.blocks:
        out[b.id].append((b.file, b.line))
        for ac in b.acs:
            out[ac.id].append((b.file, ac.line))
    for tc in prd.test_cases:
        out[tc.id].append((tc.file, tc.line))
    if "errors.md" in prd.docs:
        for n, line in enumerate(prd.docs["errors.md"].split("\n"), 1):
            m = _E_HEADING.match(line)
            if m:
                out[m.group(1)].append(("errors.md", n))
    for r in prd.assumptions:
        if r.cells:
            out[r.cells[0].strip("`")].append(("prd.md", r.line))
    return dict(out)


def _yaml_strings(node, line: int) -> Iterator[tuple[int, str]]:
    """Every key and scalar string of a loaded YAML tree, with its line."""
    if isinstance(node, dict):
        for k, v in node.items():
            kl = getattr(node, "key_lines", {}).get(k, line)
            if isinstance(k, str):
                yield kl, k
            yield from _yaml_strings(v, kl)
    elif isinstance(node, (list, tuple)):
        for v in node:
            yield from _yaml_strings(v, line)
    elif isinstance(node, str):
        yield line, node


@rule("id-format", description="Checks that every ID in the PRD's prose and YAML has its kind's form: UJ-nn, FR-nnn, NFR-nnn, AC-nnn.n, T-nnn.n, E-nnn or A-nn. Rewrite the ID the finding quotes with the digits its pattern gives (FR-012, not FR-12).")
def id_format(prd: Prd):
    def check(file: str, n: int, text: str):
        for m in _TOKEN.finditer(text):
            if not ID_PATTERNS[m.group(1)].fullmatch(m.group(0)):
                yield Finding(file, n, "id-format", f"'{m.group(0)}' does not match the {m.group(1)} id format {ID_PATTERNS[m.group(1)].pattern}")

    for rel, n, text in prose(prd):
        yield from check(rel, n, text)
    sources = list(prd.yaml.items()) + [(tc.file, {tc.id: tc.data}) for tc in prd.test_cases]
    for rel, data in sources:
        for n, text in _yaml_strings(data, 1):
            yield from check(rel, n, text)


@rule("id-unique", description="Checks that each ID is defined once (a block heading, an AC, a test-case key, an errors.md entry, an assumption row), that no key repeats in a test-cases file, and that an FR and an NFR never share a number, since they use one sequence. Renumber the later definition (`prd change ids next` gives the next free FR, NFR, UJ, AC or T number), or delete the repeated key; the first one is kept.")
def id_unique(prd: Prd):
    # duplicate keys within one test-case file are reported by the loader under this rule
    ids = defined_ids(prd)
    for key, places in ids.items():
        for file, n in places[1:]:
            yield Finding(file, n, "id-unique", f"{key} is already defined at {places[0][0]}:{places[0][1]}")
    by_number: dict[str, dict[str, tuple[str, int]]] = defaultdict(dict)
    for b in prd.blocks:
        if b.kind in ("FR", "NFR"):
            by_number[b.id.split("-")[1]].setdefault(b.kind, (b.file, b.line))
    for number, kinds in by_number.items():
        if len(kinds) > 1:
            file, n = kinds["NFR"]
            yield Finding(file, n, "id-unique", f"FR-{number} and NFR-{number} share a number; FR and NFR use one sequence")


def _removed(prd: Prd) -> tuple[set[str], list[Finding]]:
    """IDs removed in both the index and the block, and findings for the ones that disagree."""
    block = {b.id: b for b in prd.blocks}
    removed: set[str] = set()
    findings: list[Finding] = []
    for row in prd.index:
        b = block.get(row.id)
        if not b:
            continue
        in_index, in_block = row.status == "removed", b.status == "removed"
        if in_index and in_block:
            removed.add(row.id)
        elif in_index != in_block:
            findings.append(Finding("prd.md", row.line, "id-removed-reused", f"{row.id} is '{row.status}' in the index but '{b.status}' in {b.file}:{b.line}; both must say removed or neither"))
    return removed, findings


def _traces(b: ReqBlock) -> Iterator[tuple[int, str]]:
    on = False
    for n, text in b.lines:
        if text.startswith("Traces:"):
            on = True
            yield n, text
        elif on and text.startswith("  ") and text.strip():
            yield n, text
        else:
            on = False


def _walk_prd_ids(node) -> Iterator[tuple[int, str]]:
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "x-prd-ids" and isinstance(v, list):
                kl = getattr(node, "key_lines", {}).get(k, 1)
                for item in v:
                    yield kl, str(item)
            else:
                yield from _walk_prd_ids(v)
    elif isinstance(node, (list, tuple)):
        for v in node:
            yield from _walk_prd_ids(v)


@rule("id-removed-reused", description="Checks that a requirement's block and its section 11 row agree on removed, both saying it or neither, and that no test case's ac:, x-prd-ids entry or Traces line cites a removed requirement or AC. Make both places say removed, or neither, as the requirement stands, or cite a live ID instead; IDs are never reused.")
def id_removed_reused(prd: Prd):
    removed, findings = _removed(prd)
    yield from findings
    removed_acs = {a.id for b in prd.blocks for a in b.acs if a.removed}

    def gone(token: str) -> str | None:
        """How a cited ID is removed ("removed AC-001.3", "AC-003.1 of removed FR-003"), or None."""
        if token in removed or token in removed_acs:
            return f"removed {token}"
        m = re.fullmatch(r"AC-(\d+)\.\d+", token)
        parent = m and next((p for p in (f"FR-{m.group(1)}", f"NFR-{m.group(1)}") if p in removed), None)
        return f"{token} of removed {parent}" if parent else None

    for tc in prd.test_cases:
        why = gone(str(tc.data.get("ac", "")))
        if why:
            yield Finding(tc.file, tc.data.key_lines.get("ac", tc.line), "id-removed-reused", f"test case {tc.id} cites {why}")
    for rel, data in prd.yaml.items():
        for n, item in _walk_prd_ids(data):
            why = gone(item)
            if why:
                yield Finding(rel, n, "id-removed-reused", f"x-prd-ids cites {why}")
    for b in prd.blocks:
        if b.id in removed:
            continue
        for n, text in _traces(b):
            for token in _REQ_ID.findall(text):
                why = gone(token)
                if why:
                    yield Finding(b.file, n, "id-removed-reused", f"{b.id} Traces cites {why}")


@rule("index-consistent", description="Checks that the section 11 index and the requirement blocks agree: one row per block and one block per row, the same title, file and status, a known status, a since version on live, and a Source line on as-built; that each errors.md Touches ID names a block and no resolved entry is unclassified; and that each adoption area past not started has its features/<area>.md. Edit the index row or the block until the two match, as the message says; correct the Touches ID, classify the resolved entry, or add the area's features file or set the area to not started.")
def index_consistent(prd: Prd):
    block = {b.id: b for b in prd.blocks}
    rows: dict[str, IndexRow] = {}
    for r in prd.index:
        if r.id in rows:
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id} appears twice in the section 11 index (first at prd.md:{rows[r.id].line})")
        rows.setdefault(r.id, r)
    for a in prd.adoption or []:
        if a.state in ADOPTION_STATES and a.state != "not started" and f"features/{a.area}.md" not in prd.docs:
            yield Finding("adoption.md", a.line, "index-consistent", f"adoption area '{a.area}' is {a.state} but features/{a.area}.md does not exist")
    for e in prd.errors_ledger.values():
        if e.classification == "unclassified" and not e.open:
            yield Finding("errors.md", e.line, "index-consistent", f"{e.id}: unclassified is allowed only on an open entry")
        for req, n in e.touches:
            if req not in block:
                yield Finding("errors.md", n, "index-consistent", f"{e.id} Touches {req}, which no block defines")
    for b in prd.blocks:
        if b.status == "as-built" and not b.source:
            yield Finding(b.file, b.line, "index-consistent", f"{b.id} is as-built but has no 'Source: <file>:<line> @<commit>' line")
        if b.id not in rows:
            yield Finding(b.file, b.line, "index-consistent", f"{b.id} has no row in the section 11 index")
    for r in prd.index:
        b = block.get(r.id)
        if not b:
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id} is in the index but has no block")
            continue
        if r.title != b.title:
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id}: index title '{r.title}' differs from block title '{b.title}'")
        if r.file != b.file:
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id}: index file '{r.file}' differs from block file '{b.file}'")
        bad = False
        if r.status not in REQ_STATUSES:
            bad = True
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id}: unknown index status '{r.status}'")
        if b.status not in REQ_STATUSES:
            bad = True
            yield Finding(b.file, b.line, "index-consistent", f"{b.id}: unknown status '{b.status}'")
        if r.status == "live" and not r.since:
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id} is live but the index has no Since")
        if b.status == "live" and not b.since:
            yield Finding(b.file, b.line, "index-consistent", f"{b.id} is live but its Status line has no '(since X.Y.Z)'")
        # a removed/other mismatch is id-removed-reused's to report
        if not bad and r.status != b.status and "removed" not in (r.status, b.status):
            yield Finding("prd.md", r.line, "index-consistent", f"{r.id}: index status '{r.status}' differs from block status '{b.status}'")


@rule("fr-has-ac", description="Checks that every FR and NFR that is not removed has at least one acceptance criterion that is not removed. Add an AC-nnn.n line under Acceptance (EARS):, or mark the requirement removed.")
def fr_has_ac(prd: Prd):
    for b in prd.blocks:
        if b.kind not in ("FR", "NFR") or b.status == "removed":
            continue
        if not b.acs:
            yield Finding(b.file, b.line, "fr-has-ac", f"{b.id} has no acceptance criteria")
        elif all(a.removed for a in b.acs):
            yield Finding(b.file, b.line, "fr-has-ac", f"{b.id} has no live acceptance criteria; remove the requirement instead")


@rule("ac-ears", description="Checks that each live acceptance criterion starts with an EARS opener of the PRD's language table (When, While, If, Where) or the ubiquitous form The <thing> shall, and contains its modal verb (shall). Rewrite the AC in one of the EARS patterns of references/ears.md.")
def ac_ears(prd: Prd):
    table = languages.for_prd(prd)
    if table is None:
        return
    head = table.opener()
    for b in prd.blocks:
        for ac in (a for a in b.acs if not a.removed):
            if not (head.match(ac.text) or table.ubiquitous.match(ac.text)):
                yield Finding(b.file, ac.line, "ac-ears", table.ears_message(ac.id))
            elif table.modal and not table.modal.search(ac.text):
                yield Finding(b.file, ac.line, "ac-ears", f"{ac.id} must contain '{table.modal_word}'")


@rule("nfr-bound", description="Checks that each NFR that is not removed states a measurable bound: a number with a unit such as ms, s, %, requests/s or MB, outside its IDs. Write the number a test can fail against, such as within 200 ms at p95.")
def nfr_bound(prd: Prd):
    for b in prd.blocks:
        if b.kind == "NFR" and b.status != "removed":
            text = _REQ_ID.sub("", "\n".join(t for _, t in b.lines))
            if not _UNIT.search(text):
                yield Finding(b.file, b.line, "nfr-bound", f"{b.id} states no measurable bound (a number with a unit such as ms, %, requests/s)")
