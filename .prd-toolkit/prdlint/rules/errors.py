"""error-entries: the format of an errors.md entry's Detected, Confirmed, Evidence, Recurrence and class lines.

Detected and Recurrence of are checked only on entries that carry Confirmed: (written under 0.6's loop)."""
import re

from .. import errorreopen
from ..cardcontext import ENTRY_URL, well_formed
from ..findings import Finding
from ..model import CLASSES, Prd
from ..registry import rule

MAX_EVIDENCE = 20
_DETECTED = re.compile(r"^\d{4}-\d{2}-\d{2},\s+\S")


def _ids(nums: list[int]) -> tuple[str, str]:
    """The missing IDs as prose, and the verb and restore wording that match them."""
    ids = [f"E-{n:03d}" for n in nums]
    if len(ids) == 1:
        return ids[0], "is missing; entries are never deleted, restore it from git"
    text = f"{ids[0]} to {ids[-1]}" if len(ids) > 2 else ", ".join(ids)
    return text, "are missing; entries are never deleted, restore them from git"


def _sequence(prd: Prd):
    """Gap, first-entry and out-of-order findings, in ledger order, on each entry's heading."""
    entries = list(prd.errors_ledger.values())
    nums = [int(e.id[2:]) for e in entries]
    prev = None  # the entry just before this one
    top = 0  # the highest number so far
    for i, e in enumerate(entries):
        n = nums[i]
        later = set(nums[i + 1:])  # a skipped number that turns up later is no gap
        skipped = list(range(top + 1, n))
        if prev is not None and n <= top:
            yield Finding("errors.md", e.line, "error-entries",
                          f"{e.id} follows {prev.id}: entries run from E-001 upward, newest last")
        elif skipped and not later.intersection(skipped):
            text, tail = _ids(skipped)
            where = "is the first entry" if prev is None else f"follows {prev.id}"
            yield Finding("errors.md", e.line, "error-entries", f"{e.id} {where}: {text} {tail}")
        prev, top = e, max(top, n)


@rule("error-entries", description="Checks errors.md entries: they run from E-001 upward with no gap, newest last; each has a known Classification, Evidence of at most 20 lines, and a Confirmed: in its form only on a classified entry; and an entry with Confirmed: also has Detected in its form and a Recurrence of that names an entry. Fix the line the message names, put an out-of-order entry back in sequence, and restore a deleted entry from git.")
def error_entries(prd: Prd):
    yield from _sequence(prd)
    for e in prd.errors_ledger.values():
        def f(line: int, msg: str) -> Finding:
            return Finding("errors.md", line, "error-entries", f"{e.id}: {msg}")

        # Detected: and Recurrence of: are judged on 0.6-loop entries only (those with Confirmed:);
        # entries written before 0.6 need no edit (spec §14)
        loop = e.confirmed_raw is not None
        if loop and e.detected_line and not _DETECTED.match(e.detected):
            yield f(e.detected_line, 'Detected: must be "<YYYY-MM-DD>, <source>"')
        if e.classification and e.classification not in CLASSES:
            yield f(e.classification_line, f"Classification: '{e.classification}' is not one of {', '.join(CLASSES)}")
        if e.confirmed_raw is not None:
            if e.confirmed is None:
                yield f(e.confirmed_line, "Confirmed: must be '<YYYY-MM-DD>, \"<reply>\"'")
            if e.classification in ("", "unclassified"):
                yield f(e.confirmed_line, "Confirmed: on an unclassified entry")
        for raw, line in e.reopened:  # AC-146.4: each malformed Reopened: line, whatever the entry's state
            if not errorreopen.FORM.fullmatch(raw[len("Reopened:"):].strip()):
                yield f(line, errorreopen.FORM_MESSAGE)
        if e.url is not None and not well_formed(e.url):
            yield f(e.url_line, ENTRY_URL)
        if len(e.evidence) > MAX_EVIDENCE:
            yield f(e.evidence_line, f"Evidence: is {len(e.evidence)} lines; at most {MAX_EVIDENCE}")
        if loop and e.recurrence and e.recurrence != "-":
            for ref in (t.strip() for t in e.recurrence.split(",")):
                if ref not in prd.errors_ledger:
                    yield f(e.recurrence_line, f"Recurrence of: {ref} is not an entry")

