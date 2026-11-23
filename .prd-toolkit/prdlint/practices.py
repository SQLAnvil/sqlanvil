"""The practices loader: the Sources and Practices tables of a PRD folder's practices.md (FR-048).

It reads and never checks: what each cell must be is the lint rule `practices`'s to report (FR-049)."""
from dataclasses import dataclass, field

from .markdown import Row, sections, tables
from .model import Prd
from .trace import glob_re

FILE = "practices.md"  # directly in the PRD folder; one in a subfolder is not the record (AC-048.1)
SOURCES = "Sources"
PRACTICES = "Practices"


@dataclass(frozen=True)
class Source:
    id: str
    title: str
    location: str
    covers: str
    read: str
    decision: str
    line: int


@dataclass(frozen=True)
class Practice:
    id: str
    source: str
    glob: str
    applies_to: str
    practice: str
    line: int


@dataclass
class Record:
    sources: list[Source] = field(default_factory=list)
    practices: list[Practice] = field(default_factory=list)


def _rows(text: str, heading: str) -> list[Row]:
    """The rows of the first pipe table under the level-2 heading `## <heading>`; none when either is missing."""
    sec = next((s for s in sections(text, 2) if s.number is None and s.title == heading), None)
    found = tables(sec.body) if sec else []
    return found[0].rows if found else []


def _cells(row: Row, count: int) -> list[str]:
    """The row's first `count` cells, by position, stripped; a missing cell is the empty string (AC-048.3)."""
    cells = [c.strip() for c in row.cells][:count]
    return cells + [""] * (count - len(cells))


def _bare(cell: str) -> str:
    return cell.replace("`", "")


def load(prd: Prd) -> Record:
    """The sources and practices of the PRD folder's practices.md, in file order; an empty record without it."""
    text = prd.docs.get(FILE)
    record = Record()
    if text is None:
        return record
    for r in _rows(text, SOURCES):
        sid, title, location, covers, read, decision = _cells(r, 6)
        record.sources.append(Source(_bare(sid), title, _bare(location), covers, _bare(read), _bare(decision), r.line))
    for r in _rows(text, PRACTICES):
        pid, source, glob, applies_to, practice = _cells(r, 5)
        record.practices.append(Practice(_bare(pid), _bare(source), _bare(glob), _bare(applies_to), practice, r.line))
    return record


def matching(practices: list[Practice], paths: list[str]) -> list[Practice]:
    """The `code` practices whose glob matches one or more of `paths`, each once, in the table's order (AC-050.2)."""
    out = []
    for p in practices:
        if p.applies_to == "code" and any(glob_re(p.glob).match(path) for path in paths):
            out.append(p)
    return out


def source_line(s: Source) -> str:
    return f"{s.id} ({s.decision}, read {s.read}): {s.title}, {s.location}; covers {s.covers}"


def practice_line(p: Practice) -> str:
    return f"{p.id} ({p.source}, {p.applies_to}, {p.glob}): {p.practice}"


def source_dict(s: Source) -> dict:
    return {"id": s.id, "title": s.title, "location": s.location, "covers": s.covers, "read": s.read,
            "decision": s.decision, "line": s.line}


def practice_dict(p: Practice) -> dict:
    return {"id": p.id, "source": p.source, "glob": p.glob, "applies_to": p.applies_to, "practice": p.practice,
            "line": p.line}
