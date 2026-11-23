"""The rule practices: the rows of practices.md, and the S-nn IDs a section 5 row names (FR-049)."""
import datetime
import re
from collections.abc import Iterator

from .. import practices as record
from ..findings import Finding
from ..model import Prd
from ..registry import rule
from .registries import _registry_rows

DECISIONS = ("approved", "declined", "proposed")
APPLIES_TO = ("code", "prd")
_SOURCE_ID = re.compile(r"S-[0-9]{2}")
_PRACTICE_ID = re.compile(r"P-[0-9]{2}")
_DATE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")
_NAMED_SOURCE = re.compile(r"(?<![\w-])S-[0-9]{2}(?![\w-])")  # not part of a longer word: CS-01 names none


def _is_date(value: str) -> bool:
    """YYYY-MM-DD in the digits 0 to 9, naming a day of the calendar (AC-049.8)."""
    m = _DATE.fullmatch(value)
    if not m:
        return False
    try:
        datetime.date(*(int(g) for g in m.groups()))
    except ValueError:
        return False
    return True


def _citable(decision: str, approved: bool) -> bool:
    """A source a practice or a section 5 row may name: approved, or proposed while the PRD is not Approved."""
    return decision == "approved" or (decision == "proposed" and not approved)


@rule("practices", description="Checks practices.md and the sources section 5 names: each source ID is S- and two digits and each practice ID P- and two digits, once in its table; each source's Decision is approved, declined or proposed (no longer proposed once the PRD is Approved) and its Read a date YYYY-MM-DD; each practice names an approved source of the Sources table and applies to code or prd, a code practice with a glob in Object (glob); and each S-nn a section 5 row's Rules live in cell names is an approved source. Fix the cell the message names, or add or approve the source in the Sources table.")
def practices(prd: Prd) -> Iterator[Finding]:
    if record.FILE not in prd.docs:
        return
    approved = prd.frontmatter.get("status", "").strip() == "Approved"
    rec = record.load(prd)

    def at(line: int, message: str) -> Finding:
        return Finding(record.FILE, line, "practices", message)

    # the checks of one row are yielded in the order of the criteria; lint's stable sort keeps it
    first: dict[str, int] = {}
    for s in rec.sources:
        if not _SOURCE_ID.fullmatch(s.id):
            yield at(s.line, f"source ID '{s.id}' is not S- and two digits")
        if s.id in first:
            yield at(s.line, f"{s.id} is already defined at {record.FILE}:{first[s.id]}")
        else:
            first[s.id] = s.line
        if s.decision not in DECISIONS:
            yield at(s.line, f"source {s.id}: Decision '{s.decision}' is not one of approved, declined, proposed")
        if approved and s.decision == "proposed":
            yield at(s.line, f"source {s.id} is still 'proposed' but the PRD is Approved")
        if not _is_date(s.read):
            yield at(s.line, f"source {s.id}: Read '{s.read}' is not a date YYYY-MM-DD")

    by_id: dict[str, record.Source] = {}
    for s in rec.sources:
        by_id.setdefault(s.id, s)  # the first row of the Sources table with the ID
    seen: dict[str, int] = {}
    for p in rec.practices:
        if not _PRACTICE_ID.fullmatch(p.id):
            yield at(p.line, f"practice ID '{p.id}' is not P- and two digits")
        if p.id in seen:
            yield at(p.line, f"{p.id} is already defined at {record.FILE}:{seen[p.id]}")
        else:
            seen[p.id] = p.line
        src = by_id.get(p.source)
        if src is None:
            yield at(p.line, f"practice {p.id}: source '{p.source}' is not in the Sources table")
        elif not _citable(src.decision, approved):
            yield at(p.line, f"practice {p.id}: source {p.source} is '{src.decision}', not approved")
        if p.applies_to not in APPLIES_TO:
            yield at(p.line, f"practice {p.id}: Applies to '{p.applies_to}' is not code or prd")
        if p.applies_to == "code" and p.glob in ("", "-"):
            yield at(p.line, f"practice {p.id}: a code practice needs a glob in Object (glob)")

    for r in _registry_rows(prd, 5):
        rules_live_in = r.cells[2] if len(r.cells) > 2 else ""
        for sid in dict.fromkeys(_NAMED_SOURCE.findall(rules_live_in)):
            src = by_id.get(sid)
            if src is None:
                yield Finding("prd.md", r.line, "practices", f"standards row names {sid}, which is not in {record.FILE}")
            elif not _citable(src.decision, approved):
                yield Finding("prd.md", r.line, "practices",
                              f"standards row names {sid}, which is '{src.decision}' in {record.FILE}, not approved")
