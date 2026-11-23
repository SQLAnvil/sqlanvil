"""Small markdown helpers: code stripping, frontmatter, sections, tables."""
import re
from dataclasses import dataclass, field

_FENCE = re.compile(r"^\s*(```|~~~)")
_INLINE = re.compile(r"(`+)(.+?)\1")


def strip_code(text: str) -> str:
    """Blank fenced blocks and inline code spans to spaces; line numbers and columns survive."""
    out: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
            out.append(" " * len(line))
        elif in_fence:
            out.append(" " * len(line))
        else:
            out.append(_INLINE.sub(lambda m: " " * len(m.group(0)), line))
    return "\n".join(out)


def mask_quoted(text: str) -> str:
    """Blank errors.md's quoted material: `Evidence:` lines with their two-space continuations, and
    `Confirmed:` lines (the user's reply, verbatim); line numbers survive."""
    out: list[str] = []
    on = False
    for line in text.split("\n"):
        if line.startswith("Evidence:"):
            on = True
        elif not (on and line.startswith("  ")):
            on = False
        out.append(" " * len(line) if on or line.startswith("Confirmed:") else line)
    return "\n".join(out)


def frontmatter(text: str) -> tuple[dict[str, str], int]:
    """Parse the leading `---` block into {key: value}. Returns (fields, line of the opening ---),
    or ({}, 0) when there is none."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return {}, 0
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fields, 1
        m = re.match(r"^([A-Za-z][\w-]*):\s*(.*?)\s*$", line)
        if m:
            fields[m.group(1)] = m.group(2)
    return {}, 0  # unterminated


@dataclass
class Section:
    number: int | None
    title: str
    line: int
    body: list[tuple[int, str]] = field(default_factory=list)


def sections(text: str, level: int = 2) -> list[Section]:
    """Split on headings of exactly `level`; a heading of that level or shallower ends a section.
    Body holds (1-based line, original text) pairs. Headings inside code fences are ignored."""
    head = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
    out: list[Section] = []
    for n, (orig, stripped) in enumerate(zip(text.split("\n"), strip_code(text).split("\n")), 1):
        m = head.match(stripped)
        if m and len(m.group(1)) <= level:
            if len(m.group(1)) == level:
                title = head.match(orig).group(2)
                num = re.match(r"^(\d+)\.\s+(.*)$", title)
                out.append(Section(int(num.group(1)) if num else None, num.group(2) if num else title, n))
            else:
                out.append(Section(-1, "", n))  # closer for a shallower heading
            continue
        if out:
            out[-1].body.append((n, orig))
    return [s for s in out if s.number != -1]


@dataclass
class Row:
    cells: list[str]
    line: int


@dataclass
class Table:
    header: list[str]
    rows: list[Row]
    line: int = 0


def split_cells(line: str) -> list[str]:
    """Split a table line on unescaped pipes outside backticks; cells keep their backticks."""
    s = line.strip()
    s = s[1:] if s.startswith("|") else s
    s = s[:-1] if s.endswith("|") and not s.endswith("\\|") else s
    cells, cur, in_code, i = [], [], False, 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            cur.append("|")
            i += 2
            continue
        if c == "`":
            in_code = not in_code
        if c == "|" and not in_code:
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(c)
        i += 1
    cells.append("".join(cur).strip())
    return cells


_SEP = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")


def tables(body: list[tuple[int, str]]) -> list[Table]:
    """Find pipe tables in a section body: header line, separator line, then rows."""
    out: list[Table] = []
    i = 0
    while i < len(body):
        n, text = body[i]
        if text.lstrip().startswith("|") and i + 1 < len(body) and _SEP.match(body[i + 1][1]):
            table = Table(split_cells(text), [], n)
            i += 2
            while i < len(body) and body[i][1].lstrip().startswith("|"):
                table.rows.append(Row(split_cells(body[i][1]), body[i][0]))
                i += 1
            out.append(table)
        else:
            i += 1
    return out
