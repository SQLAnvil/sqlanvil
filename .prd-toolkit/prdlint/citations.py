"""Where a PRD cites an upstream PRD's items: test-case targets, Traces tokens and prefixed prose spans.

A target or token `<kind>:<a>/<b>` is prefixed when `<a>` is a slug and `<kind>` is not `code`, and only the
crossing kinds (op, table, event, job, a custom type) cite across repositories. A custom type is the upstream's:
the citing PRD need not declare it (R-10b), so every prefixed kind that is not a built-in target kind crosses;
`sync` resolves it in the upstream and `upstream-refs` in the snapshot, whose header names the type. A prose span
`<a>/<t>.<c>` cites table `t` only when `<a>` is a name in the Upstreams table, so paths such as
`src/importer.py` stay prose, and a span whose last part is a file extension (`greet/cli.py`) is a path, not a table
citation. A table name is cited lowercased, as `test-refs` matches it; the snapshot folds case the same way. `sync` and
the `snapshot-cited` and `upstream-refs` rules share this.
"""
import re
from typing import NamedTuple

from .model import CROSSING, Prd, parse_ref

_SPAN = re.compile(r"(`+)(.+?)\1")
_FENCE = re.compile(r"^\s*(```|~~~)")
_PROSE_REF = re.compile(r"([a-z][a-z0-9-]*)/([A-Za-z_]\w*)\.([A-Za-z_]\w*)")
_QUOTES = "`'\".,;:)("


class Cite(NamedTuple):
    upstream: str
    kind: str
    name: str
    file: str
    line: int
    label: str  # who cites: a T-id, a requirement ID, or the backticked prose span
    ref: str  # the citation as written
    column: str | None = None  # a prose span's column


def crosses(kind: str) -> bool:
    """A crossing built-in kind, or any kind that is not a built-in target kind (an upstream's custom type)."""
    from .rules.testcases import TARGET_KINDS

    return kind in CROSSING or kind not in TARGET_KINDS


def _upstream_names(prd: Prd) -> set[str]:
    return {r.name for r in prd.links.upstreams} if prd.links else set()


def cites(prd: Prd) -> list[Cite]:
    """Every citation of an upstream item; none in a PRD without links.md, which keeps its pre-0.7 meaning (R-10c)."""
    from .rules.ids import _traces

    if prd.links is None:
        return []
    out: list[Cite] = []

    from .rules.contracts import _FILE_EXTENSIONS

    paths = _FILE_EXTENSIONS | {"py"}

    def prefixed(ref: str):
        kind, prefix, name = parse_ref(ref)
        return (kind, prefix, name.lower() if kind == "table" else name) if prefix is not None and crosses(kind) else None

    for tc in prd.test_cases:
        target = tc.data.get("target") if isinstance(tc.data, dict) else None
        p = prefixed(target) if isinstance(target, str) else None
        if p:
            out.append(Cite(p[1], p[0], p[2], tc.file, tc.data.key_lines.get("target", tc.line), tc.id, target))
    for b in prd.blocks:
        for n, text in _traces(b):
            for tok in re.split(r"[;,\s]+", text):
                tok = tok.strip(_QUOTES)
                p = prefixed(tok) if re.fullmatch(r"[a-z][a-z0-9-]*:\S+", tok) else None
                if p:
                    out.append(Cite(p[1], p[0], p[2].strip(_QUOTES), b.file, n, b.id, tok))
    names = _upstream_names(prd)
    for rel, text in prd.docs.items():
        if rel in ("errors.md", "links.md") or not names:
            continue
        on = False
        for n, line in enumerate(text.split("\n"), 1):
            if _FENCE.match(line):
                on = not on
                continue
            if on:
                continue
            for m in _SPAN.finditer(line):
                q = _PROSE_REF.fullmatch(m.group(2).strip())
                if q and q.group(1) in names and q.group(3) not in paths:
                    out.append(Cite(q.group(1), "table", q.group(2).lower(), rel, n, f"`{q.group(0)}`", q.group(0), q.group(3)))
    return out


def collect(prd: Prd) -> dict[str, dict[tuple[str, str], list[tuple[str, int]]]]:
    """Upstream name -> (kind, name) -> every (file, line) citing it."""
    out: dict[str, dict[tuple[str, str], list[tuple[str, int]]]] = {}
    for c in cites(prd):
        out.setdefault(c.upstream, {}).setdefault((c.kind, c.name), []).append((c.file, c.line))
    return out
