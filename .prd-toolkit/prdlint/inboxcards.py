"""The decision inbox's error-class cards across worktrees (FR-071): an errors.md entry's card shows in the first group
whose PRD folder holds that entry; a later group whose PRD folder holds the same entry leaves the card out."""
from .model import Prd


def entries(prd: Prd) -> set[tuple[str, str, str]]:
    """(ID, title, `Detected:` value) of every errors.md entry of the PRD, whatever its state (AC-071.1)."""
    return {(e.id, e.title, e.detected) for e in prd.errors_ledger.values()}


def held_earlier(gate, prd: Prd, held: set[tuple[str, str, str]]) -> bool:
    """True for an `error-class:<E-id>` gate whose entry, by ID, title and `Detected:` value, an earlier group holds; an
    entry of that ID with another title or `Detected:` value is another entry (AC-071.1)."""
    if gate.kind != "error-class":
        return False
    e = prd.errors_ledger.get(gate.id.split(":", 1)[1])
    return e is not None and (e.id, e.title, e.detected) in held
