"""Linked-PRD rules: links-format, upstream-refs, snapshot-cited and change-sets (prd-toolkit 0.7)."""
import re
from collections.abc import Iterator

from ..citations import cites
from ..findings import Finding
from ..markdown import sections, strip_code, tables
from ..model import LINKS_FILE, SLUG, STATES, Prd
from ..registry import rule

_HEADINGS = ("# Links", "## Upstreams", "## Consumers")
_UPSTREAM_HEADER = ["Upstream", "Location", "Version", "Commit", "Needs"]
_LOCATION = re.compile(r"`([^`\s][^`]*)`")
_URL = re.compile(r"(?:[a-z][a-z0-9+.-]*://|[\w.-]+@[\w.-]+:)")
_VERSION = re.compile(r"\d+\.\d+\.\d+")
_COMMIT = re.compile(r"[0-9a-fA-F]{7,40}")
_NEEDS = re.compile(r"(?:verified|live in \S.*)")
_LOCATION_MSG = "location must be a backticked path or a backticked <git URL>#<folder>"


def _location_ok(cell: str) -> bool:
    m = _LOCATION.fullmatch(cell.strip())
    if not m:
        return False
    loc = m.group(1)
    if _URL.match(loc):
        folder = loc.partition("#")[2]
        return bool(folder.strip())
    return True


@rule("links-format", description="Checks links.md: its # Links, ## Upstreams and ## Consumers headings, the Upstreams header, each upstream a unique PRD slug, each upstream and consumer location a backticked path or a backticked git URL with #<folder>, an upstream's version X.Y.Z and commit of 7-40 hex digits set together, and Needs verified or live in an environment. Add the missing heading, or fix the header or cell the message names; only prd_links.py sync writes Version and Commit.")
def links_format(prd: Prd):
    links = prd.links
    if links is None:
        return
    for h in _HEADINGS:
        if h not in links.headings:
            yield Finding(LINKS_FILE, 0, "links-format", f'links.md: missing heading "{h}"')
    for s in sections(prd.docs[LINKS_FILE]):
        if s.title.strip().lower() == "upstreams":
            ts = tables(s.body)
            if ts and [h.strip() for h in ts[0].header] != _UPSTREAM_HEADER:
                yield Finding(LINKS_FILE, ts[0].line, "links-format",
                              f"links.md:{ts[0].line}: Upstreams header must be | " + " | ".join(_UPSTREAM_HEADER) + " |")
    seen: set[str] = set()
    for r in links.upstreams:
        def bad(msg: str, r=r):
            return Finding(LINKS_FILE, r.line, "links-format", msg)

        if not SLUG.fullmatch(r.name):
            yield bad(f"upstream '{r.name}' is not a PRD slug")
        elif r.name in seen:
            yield bad(f"upstream '{r.name}' appears twice")
        seen.add(r.name)
        if not _location_ok(r.location):
            yield bad(_LOCATION_MSG)
        if r.version and not _VERSION.fullmatch(r.version):
            yield bad(f"version '{r.version}' must be X.Y.Z")
        if r.commit and not _COMMIT.fullmatch(r.commit):
            yield bad(f"commit '{r.commit}' must be 7-40 hex digits")
        if bool(r.version) != bool(r.commit):
            yield bad("version and commit are both set or both empty")
        if r.needs and not _NEEDS.fullmatch(r.needs):
            yield bad(f"needs '{r.needs}' must be verified or live in <env>")
    for r in links.consumers:
        if not _location_ok(r.location):
            yield Finding(LINKS_FILE, r.line, "links-format", _LOCATION_MSG)


def _snapshot_contracts(prd: Prd, upstream: str):
    from ..snapshot import contracts_of_snapshot

    return contracts_of_snapshot(prd.snapshots[upstream])


def _columns(c) -> dict[str, set[str]]:
    from sqlglot import exp

    from .contracts import create_tables, parse_schema

    text = c.files.get("schema.sql")
    out: dict[str, set[str]] = {}
    for name, stmt in create_tables((parse_schema(text, c.dialect) if text is not None else None) or []):
        out.setdefault(name.lower(), set()).update(col.name for col in stmt.find_all(exp.ColumnDef))
    return out


@rule("upstream-refs", description="Checks that each reference to an upstream item (a prefixed target, Traces token or prose span) names an Upstreams row, a kind that crosses repositories, and an item, or column, present in that upstream's snapshot. Run prd_links.py sync to bring the item into the snapshot, or correct the reference.")
def upstream_refs(prd: Prd):
    from ..citations import crosses
    from ..model import parse_ref, ref_prefix
    from ..snapshot import items

    names = {r.name for r in prd.links.upstreams} if prd.links else set()
    for tc in prd.test_cases:
        target = tc.data.get("target") if isinstance(tc.data, dict) else None
        if not isinstance(target, str) or ref_prefix(prd, target) is None:
            continue
        kind = parse_ref(target)[0]
        if not crosses(kind):
            yield Finding(tc.file, tc.data.key_lines.get("target", tc.line), "upstream-refs",
                          f"{tc.id}: target {target}: kind '{kind}' does not cross repositories")
    have, cols = {}, {}
    for c in cites(prd):
        who = f"{c.label}: target {c.ref}" if c.column is None else f"{c.label}"

        def bad(msg: str, c=c):
            return Finding(c.file, c.line, "upstream-refs", msg)

        if c.upstream not in names:
            yield bad(f"{who} names no Upstreams row '{c.upstream}'")
            continue
        if c.upstream not in have:
            if c.upstream in prd.snapshots:
                contracts = _snapshot_contracts(prd, c.upstream)
                have[c.upstream], cols[c.upstream] = items(contracts), _columns(contracts)
            else:
                have[c.upstream], cols[c.upstream] = {}, {}
        present = have[c.upstream].get(c.kind, set())
        if c.kind == "table":
            present = {n.lower() for n in present}
        key = c.name.lower() if c.kind == "table" else c.name
        if key not in present:
            yield bad(f"{who}: no {c.kind} '{c.name}' in the {c.upstream} snapshot")
        elif c.column is not None and c.column not in cols[c.upstream].get(key, set()):
            yield bad(f"{who}: no column '{c.column}' in table {c.name} in the {c.upstream} snapshot")


@rule("snapshot-cited", description="Checks that each snapshot folder under contracts/upstream/ has an Upstreams row, that each snapshot file is readable UTF-8 with its header line and that every item in it is cited, and that every Upstreams row is cited somewhere. Cite the item, or run prd_links.py sync to rewrite the snapshot and drop what is no longer cited; add the Upstreams row for a folder that has none, or delete the folder, and cite or delete an Upstreams row that nothing cites.")
def snapshot_cited(prd: Prd):
    from ..snapshot import contracts_of_snapshot, items

    if prd.links is None:  # R-10c: a PRD without links.md has no snapshot
        return
    cited: dict[str, set[tuple[str, str]]] = {}
    all_cites = cites(prd)
    for c in all_cites:
        cited.setdefault(c.upstream, set()).add((c.kind, c.name.lower() if c.kind == "table" else c.name))
    names = {r.name for r in prd.links.upstreams} if prd.links else set()
    unreadable = {f.file for f in prd.load_findings if f.rule == "snapshot-cited"}
    for folder, files in prd.snapshots.items():
        if folder not in names:
            yield Finding(f"contracts/upstream/{folder}", 0, "snapshot-cited", f"contracts/upstream/{folder}/: no Upstreams row '{folder}'")
        for s in files:
            if s.rel in unreadable:
                continue
            if s.header is None:
                yield Finding(s.rel, 0, "snapshot-cited", f"{s.rel}: no snapshot header line")
                continue
            have = cited.get(folder, set())
            for kind, found in items(contracts_of_snapshot([s])).items():
                if kind == "job":  # events.md does not tell an event from a job: list its items once, as events
                    continue
                for name in sorted(found):
                    if {("event", name), ("job", name)} & have if kind == "event" else (kind, name.lower() if kind == "table" else name) in have:
                        continue
                    yield Finding(s.rel, 0, "snapshot-cited", f"{s.rel}: {kind} {name} is cited nowhere")
    for r in prd.links.upstreams if prd.links else []:
        if not any(c.upstream == r.name for c in all_cites):
            yield Finding(LINKS_FILE, r.line, "snapshot-cited", f"Upstreams row '{r.name}' is cited nowhere")


_CS_STATUS = re.compile(r"(?:proposed|approved|running|done|abandoned|stopped: [a-z][a-z0-9-]*: \S.*)")
_CS_STATE = re.compile(r"(?:proposed|approved|built|verified|live in \S.*)")
_CS_HEADING = re.compile(r"^# (CS-\d{3})\b")


def _rank(state: str) -> int:
    return STATES.index(state) if state in STATES else len(STATES)  # `live in <env>` is the last


@rule("change-sets", description="Checks each changes/CS-nnn.md record against the change-set grammar: the # CS-nnn <title> first line, a Started: line and one Status: line in their forms, each Approval: line, the table header, nine cells a row with Version, IDs, Waits for, State and Target in their forms, Order 1, 2, … in table order, a ## Log section and its lines, Merge order lines, no row short of its target once Status is done, and each CS ID defined once. Records are written by prd_links.py changeset; fix the line the message names to the form it gives.")
def change_sets(prd: Prd):
    if prd.links is None:  # R-10c: changes/ is an ordinary folder in a PRD without links.md
        return
    heading_lines: dict[str, list[tuple[str, int]]] = {}
    texts: dict[str, str] = {}
    for cs in prd.change_sets.values():
        texts[cs.id] = (prd.root / cs.file).read_text(encoding="utf-8")
        for n, line in enumerate(strip_code(texts[cs.id]).split("\n"), 1):
            m = _CS_HEADING.match(line)
            if m:
                heading_lines.setdefault(m.group(1), []).append((cs.file, n))
    for cs in prd.change_sets.values():
        def bad(msg: str, line: int = 1, cs=cs):
            return Finding(cs.file, line, "change-sets", msg)

        for n, msg in cs.problems:
            yield bad(msg, n)
        plain = strip_code(texts[cs.id]).split("\n")
        statuses = [n for n, line in enumerate(plain, 1) if line.startswith("Status:")]
        if not cs.started:
            yield bad(f"{cs.id}: no Started: line")
        if not cs.status:
            yield bad(f"{cs.id}: no Status: line")
        elif len(statuses) > 1:
            yield bad(f"{cs.id}: Status: appears twice", statuses[1])
        if not any(s.title.strip().lower() == "log" for s in sections(texts[cs.id], 2)):
            yield bad(f"{cs.id}: no ## Log section")
        if cs.status and not _CS_STATUS.fullmatch(cs.status):
            yield bad(f"{cs.id}: status '{cs.status}' is outside the grammar", statuses[0] if statuses else 1)
        for r in cs.rows:
            for label, value in (("state", r.state), ("target", r.target)):
                if not _CS_STATE.fullmatch(value):
                    yield bad(f"{cs.id}: row {r.prd}: {label} '{value}' is outside the grammar", r.line)
        for i, r in enumerate(cs.rows, 1):
            if r.order != str(i):
                yield bad(f"{cs.id}: Order must be 1, 2, … in table order", r.line)
                break
        if cs.status == "done":
            for r in cs.rows:
                if _CS_STATE.fullmatch(r.state) and _CS_STATE.fullmatch(r.target) and _rank(r.state) < _rank(r.target):
                    yield bad(f"{cs.id}: Status done, but row {r.prd} is {r.state}, not its target {r.target}", r.line)
    for cid, spots in heading_lines.items():
        for file, n in spots[1:]:
            yield Finding(file, n, "change-sets", f"{cid} is defined twice")
