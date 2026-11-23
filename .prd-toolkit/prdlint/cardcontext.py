"""The area and the URL of a gate (card-context): which areas a gate is for, and the address its card links to.

The area of a block is its features file's name without `.md`, `nfr` for nfr.md; the PRD's area order is the order the
loader reads the blocks in. An area's URL is the address of the url part of its `Target:` line. Nothing fetches a URL."""
from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # model imports this module: no import of it at load time
    from .gates import Gate
    from .model import Prd, ReqBlock

URL_RULE = "must start with http:// or https:// and hold no white space"
ENTRY_URL = f"URL: {URL_RULE}"  # an errors.md entry's URL: line (error-entries; prd error new --url and url)
TARGET_URL = f"Target: url {URL_RULE}"  # the url part of a Target: line (pack-resolves)
_WELL_FORMED = re.compile(r"https?://\S+")
_AC = re.compile(r"AC-\d+\.\d+")
_T = re.compile(r"T-(\d+)\.\d+")


def well_formed(address: str) -> bool:
    """`http://` or `https://`, one or more characters after it, and no white space."""
    return bool(_WELL_FORMED.fullmatch(address))


def block_area(b: ReqBlock) -> str:
    """`features/import.md` is `import`; a block of nfr.md is `nfr`."""
    return "nfr" if b.file == "nfr.md" else Path(b.file).stem


def _in_order(prd: Prd, areas) -> list[str]:
    """Each area once, in the PRD's area order: the order the loader read the blocks in."""
    rank: dict[str, int] = {}
    for b in prd.blocks:
        rank.setdefault(block_area(b), len(rank))
    return sorted(dict.fromkeys(areas), key=lambda a: rank.get(a, len(rank)))


def _by_id(prd: Prd) -> dict[str, ReqBlock]:
    out: dict[str, ReqBlock] = {}
    for b in prd.blocks:
        out.setdefault(b.id, b)
    return out


def area_url(prd: Prd, area: str) -> str | None:
    """The address of the url part of the area's `Target:` line; None without one, and for `nfr`."""
    target = prd.targets.get(area) if area != "nfr" else None
    return target.url if target else None


def entry_areas(prd: Prd, eid: str) -> list[str]:
    """AC-062.1: the areas of the blocks `Touches:` names, then those of the owners of the cases known-failing on the entry."""
    from .context import _entry_reqs

    entry = prd.errors_ledger.get(eid)
    if entry is None:
        return []
    by_id = _by_id(prd)
    touched = _in_order(prd, (block_area(by_id[i]) for i, _ in entry.touches if i in by_id))
    owners = _in_order(prd, (block_area(by_id[i]) for i in _entry_reqs(prd, eid) if i in by_id))
    return touched + [a for a in owners if a not in touched]


def touch_areas(prd: Prd, touches: list[str]) -> list[str]:
    """AC-062.3: the areas of the blocks an approval verdict's `touches` names."""
    by_id = _by_id(prd)
    found = []
    for t in touches:
        t = str(t)
        if t in by_id:
            found.append(block_area(by_id[t]))
        elif _AC.fullmatch(t):
            found += [block_area(b) for b in prd.blocks if any(a.id == t for a in b.acs)][:1]
        elif m := _T.fullmatch(t):
            found += [block_area(b) for b in prd.blocks if b.kind in ("FR", "NFR") and int(b.id.split("-")[1]) == int(m.group(1))][:1]
    return _in_order(prd, found)


def gate_areas(prd: Prd, gate: Gate, touches: list[str] | None = None) -> list[str]:
    """FR-062: a gate's areas, by its kind; `touches` is an approval gate's verdict list."""
    key = gate.id.split(":", 1)[1] if ":" in gate.id else ""
    if gate.kind == "error-class":
        return entry_areas(prd, key)
    if gate.kind == "signoff":
        tc = next((t for t in prd.test_cases if t.id == key), None)
        return [Path(tc.file).stem] if tc else []
    if gate.kind == "adoption":
        return [key]
    if gate.kind == "approval":
        return touch_areas(prd, touches or [])
    return []  # deploy-step: a run deploys the whole PRD


def gate_url(prd: Prd, gate: Gate, areas: list[str]) -> str | None:
    """FR-066: a gate's URL; a malformed address is passed over, never linked."""
    if gate.kind == "error-class":
        entry = prd.errors_ledger.get(gate.id.split(":", 1)[1])
        if entry is not None and entry.url is not None and well_formed(entry.url):
            return entry.url
        return next((u for u in (area_url(prd, a) for a in areas) if u), None)
    if gate.kind in ("signoff", "adoption") or (gate.kind == "approval" and len(areas) == 1):
        return area_url(prd, areas[0]) if len(areas) == 1 else None
    return None


def attach(prd: Prd, gate: Gate, touches: list[str] | None = None) -> Gate:
    """Set the gate's `areas` and `url` from the PRD it was listed from."""
    gate.areas = gate_areas(prd, gate, touches)
    gate.url = gate_url(prd, gate, gate.areas)
    return gate
