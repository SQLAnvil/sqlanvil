"""Area notes: the text a features file gives between its title line and its first block (FR-072).

The context pack prints them as the part `Area notes`, directly before `Requirements`; a file with
no area notes leaves the pack as it was.
"""
from .context import Item
from .model import Prd

PART = "Area notes"


def area_notes(text: str) -> tuple[int, list[str]] | None:
    """The area notes of a features file's text: (the 1-based number of their first line, their lines), or None.

    The lines after the title line (the first line starting `# `) and before the first line starting `### `,
    less each `Target:` line, each HTML comment that fills whole lines and the empty lines at either end.
    """
    lines = text.split("\n")
    title = next((n for n, line in enumerate(lines) if line.startswith("# ")), None)
    if title is None:
        return None
    end = next((n for n, line in enumerate(lines) if line.startswith("### ")), len(lines))
    kept: list[tuple[int, str]] = []
    in_comment = False
    for n in range(title + 1, end):
        line = lines[n]
        if not in_comment and line.lstrip().startswith("<!--"):
            in_comment = True
        if in_comment:
            if line.rstrip().endswith("-->"):
                in_comment = False
            continue
        if line.startswith("Target:"):
            continue
        kept.append((n + 1, line))
    while kept and not kept[0][1].strip():
        kept.pop(0)
    while kept and not kept[-1][1].strip():
        kept.pop()
    if not kept:
        return None
    return kept[0][0], [line for _, line in kept]


def part(prd: Prd, area: str) -> list[Item]:
    """The `Area notes` part of an area's pack: one item when its features file holds area notes, else none."""
    rel = f"features/{area}.md"
    notes = area_notes(prd.docs[rel]) if rel in prd.docs else None
    if notes is None:
        return []
    line, lines = notes
    return [Item(PART, None, rel, line, "\n".join(lines))]
