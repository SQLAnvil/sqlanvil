"""The facts a PRD's README and its published Overview tab both show, so the two never disagree."""
import re
from dataclasses import dataclass, field

from . import languages
from .markdown import strip_code

PART_KEYS = {"principles": "part_principles", "getting_started": "part_getting_started"}
_EN_LABELS = ("Goals", "Personas", "Out of scope", "Principles", "Getting started")
COUNT_ORDER = ("live", "verified", "built", "approved", "as-built")  # `removed` is left out
FILES = ("prd.md", "features/", "test-cases/", "contracts/", "testing.md", "errors.md", "operations.md", "nfr.md",
         "adoption.md", "links.md")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_HEADING = re.compile(r"^#{1,6}\s")
_SENTENCE_END = re.compile(r"[.?!](?=\s)")


@dataclass
class Area:
    name: str
    file: str
    adoption: str
    counts: dict[str, int]


@dataclass
class Facts:
    slug: str
    version: str
    status: str
    owner: str
    updated: str
    summary: str | None
    first_sentence: str
    principles: str | None
    getting_started: str | None
    areas: list[Area] = field(default_factory=list)
    open_errors: int = 0
    upstreams: list[str] = field(default_factory=list)  # each location as links.md records it
    consumers: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)


def first_sentence(text: str) -> str:
    """Up to and including the first `. `, `? ` or `! `, or the whole text; line breaks read as spaces."""
    flat = " ".join(text.split())
    m = _SENTENCE_END.search(flat)
    return flat[: m.start() + 1] if m else flat


def _section2(prd) -> list[tuple[int, str]]:
    """§2's body as (line, text) with fenced code kept, HTML comments and their lines blanked."""
    s = next((s for s in prd.sections if s.number == 2), None)
    if s is None:
        return []
    raw = "\n".join(t for _, t in s.body)
    blanked = _COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), raw).split("\n")
    return [(n, t if t.strip() else "") for (n, _), t in zip(s.body, blanked)]


def _labels(prd, key: str | None = None) -> list[str]:
    """Every label that starts a part: the English ones plus the PRD language's own part labels."""
    out = list(_EN_LABELS)
    table = languages.for_prd(prd)
    en = languages.load("en")
    for k in PART_KEYS.values():
        for t in (table, en):
            if t and t.labels.get(k) and t.labels[k] not in out:
                out.append(t.labels[k])
    return out


def _is_label(line: str, labels: list[str]) -> bool:
    return any(line.startswith(lb + ":") for lb in labels)


def summary_paragraph(prd) -> str | None:
    """§2's first paragraph: the first run of non-blank lines once HTML comments are removed, ended by a blank line
    or a heading; None when it starts with a labelled part or there is none."""
    labels = _labels(prd)
    masked = strip_code("\n".join(t for _, t in _section2(prd))).split("\n")
    run: list[str] = []
    for (_, text), m in zip(_section2(prd), masked):
        stop = not text.strip() or _HEADING.match(m)
        if stop:
            if run:
                break
            continue
        run.append(text.rstrip())
    if not run or _is_label(run[0], labels):
        return None
    return "\n".join(run)


def section2_part(prd, key: str) -> str | None:
    """The text of §2's `Principles:` or `Getting started:` part: from its label line (text after the label
    included) to the next labelled line of §2 or the end of §2; None when absent or empty."""
    if key not in PART_KEYS:
        raise ValueError(f"unknown §2 part {key!r}; expected one of {', '.join(PART_KEYS)}")
    mine = {t.labels[PART_KEYS[key]] for t in (languages.for_prd(prd), languages.load("en")) if t and t.labels.get(PART_KEYS[key])}
    labels = _labels(prd)
    body = _section2(prd)
    masked = strip_code("\n".join(t for _, t in body)).split("\n")
    out: list[str] | None = None
    for (_, text), m in zip(body, masked):
        if _is_label(m, labels):
            if out is not None:
                break
            lb = next((x for x in mine if m.startswith(x + ":")), None)
            if lb:
                out = [text[len(lb) + 1 :].strip()]
        elif out is not None:
            out.append(text.rstrip())
    if out is None:
        return None
    return "\n".join(out).strip("\n").strip() or None


def _count(prd, file: str) -> dict[str, int]:
    seen: dict[str, int] = {}
    for b in prd.blocks:
        if b.file == file and b.kind in ("FR", "NFR") and b.status:
            word = b.status.strip().lower().split(" ")[0]
            if word in COUNT_ORDER:
                seen[word] = seen.get(word, 0) + 1
    return {k: seen[k] for k in COUNT_ORDER if k in seen}


def facts(prd) -> Facts:
    fm = prd.frontmatter
    states = {r.area: r.state for r in prd.adoption or []}
    areas = [
        Area(rel[len("features/") : -3], rel, states.get(rel[len("features/") : -3], "-"), _count(prd, rel))
        for rel in sorted(r for r in prd.docs if re.fullmatch(r"features/[^/]+\.md", r))
    ]
    summary = summary_paragraph(prd)
    files = []
    for p in FILES:
        exists = any(d.startswith(p) for d in prd.docs) or (p in ("test-cases/", "contracts/") and (prd.root / p).is_dir())
        if exists if p.endswith("/") else p in prd.docs:
            files.append(p)
    return Facts(
        slug=fm.get("prd", "unknown"), version=fm.get("version", "unknown"), status=fm.get("status", "unknown"),
        owner=fm.get("owner", "unknown"), updated=fm.get("updated", "unknown"),
        summary=summary, first_sentence=first_sentence(summary) if summary else "",
        principles=section2_part(prd, "principles"), getting_started=section2_part(prd, "getting_started"),
        areas=areas, open_errors=sum(1 for e in prd.errors_ledger.values() if e.open),
        upstreams=[r.location for r in prd.links.upstreams] if prd.links else [],
        consumers=[r.location for r in prd.links.consumers] if prd.links else [],
        files=files,
    )
