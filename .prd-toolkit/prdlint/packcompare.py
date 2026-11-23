"""`prd pack compare`: what two PRDs share, part by part, for the owner who writes a pack from them (FR-057, FR-058).
It reads both folders as the lint command loads them and lints neither."""
import re
from dataclasses import dataclass

from . import languages, model
from .markdown import sections, tables

PARTS = ("Contract types", "Target kinds", "Levels", "Harness", "Standards", "Skills", "Vocabulary")
KEYS = ("contract-types", "target-kinds", "levels", "harness", "standards", "skills", "vocabulary")
FIELDS = {
    "contract-types": ("type", "files", "validator"),
    "target-kinds": ("type", "a", "b"),
    "levels": ("level", "command", "environment", "gate", "timeout"),
    "harness": ("slot", "text"),
    "standards": ("glob", "linter"),
    "skills": ("activity", "skill"),
    "vocabulary": ("word", "a", "b"),
}
NOT_CUSTOM = ("", "built-in", "pack")  # a Validator cell, read, that makes a section 7 row not custom (AC-057.2)
BUILT_IN_PACKS = ("service", "document")
DASH = "-"  # an empty value, or a column the Levels table lacks (AC-057.4)
_SPAN = re.compile(r"`([^`]*)`")
_CODE_SPAN = re.compile(r"`[^`]*`")
_SLOT = re.compile(r"^- \*\*([^*]+?)\.\*\*(.*)$")
_WORD = re.compile(r"[^\W\d_]+")  # a longest run of letters: no digit, no underscore
MIN_WORD = 4


class NothingShared(Exception):
    """No contract type name is a custom contract type of both PRDs (AC-058.2)."""


def cell(text: str) -> str:
    """A cell read: every backtick removed, each run of white space one space, none at either end (AC-057.7)."""
    return " ".join(text.replace("`", "").split())


def _collapse(text: str) -> str:
    return " ".join(text.split())


def _first_span(raw: str) -> str:
    """The text of the cell's first backticked span, its white space collapsed; the cell, read, when it has none."""
    m = _SPAN.search(raw)
    return _collapse(m.group(1)) if m else cell(raw)


@dataclass
class Item:
    key: str
    values: tuple  # every value the line prints, the key first

    def line(self, part: str, mark: str) -> str:
        v = self.values
        if part == "contract-types":
            return f"{mark} {v[0]}: {v[1]}; {v[2]}"
        if part == "levels":
            return f"{mark} {v[0]}: {v[1]}; environment {v[2]}; gate {v[3]}; timeout {v[4]}"
        if part in ("target-kinds", "vocabulary"):
            return f"{mark} {v[0]}: {v[1]} in A, {v[2]} in B"
        return f"{mark} {v[0]}: {v[1]}"


def _rows(prd: model.Prd, number: int):
    s = next((s for s in prd.sections if s.number == number), None)
    return [r for t in (tables(s.body) if s else []) for r in t.rows]


def custom_rows(prd: model.Prd):
    """Each section 7 row of three or more cells whose Validator, read, is neither empty nor built-in nor pack
    (AC-057.2)."""
    return [r for r in _rows(prd, 7) if len(r.cells) >= 3 and cell(r.cells[2]) not in NOT_CUSTOM]


def contract_types(prd: model.Prd) -> list[Item]:
    out = []
    for r in custom_rows(prd):
        values = (cell(r.cells[0]), cell(r.cells[1]), cell(r.cells[2]))
        out.append(Item(values[0], values))
    return out


def _testing_section(prd: model.Prd, title: str):
    """The section under the level-2 heading `## <title>` of testing.md; None when there is none."""
    text = prd.docs.get("testing.md")
    if text is None:
        return None
    return next((s for s in sections(text) if s.number is None and s.title.strip() == title), None)


def levels(prd: model.Prd) -> list[Item]:
    """One item per row of the table under `## Levels` (AC-057.4)."""
    s = _testing_section(prd, "Levels")
    found = tables(s.body) if s else []
    if not found:
        return []
    t = found[0]
    header = [cell(h) for h in t.header]

    def col(row, name: str) -> str:
        i = header.index(name) if name in header else -1
        return cell(row.cells[i]) if 0 <= i < len(row.cells) else ""

    out = []
    for r in t.rows:
        level = cell(r.cells[0]) if r.cells else ""
        command = _first_span(r.cells[1]) if len(r.cells) > 1 else ""
        values = tuple(v or DASH for v in (level, command, col(r, "Environment"), col(r, "Gate"), col(r, "Timeout")))
        out.append(Item(values[0], values))
    return out


def harness(prd: model.Prd) -> list[Item]:
    """One item per `- **<slot>.**` bullet of `## Harness`, its indented next lines joined to it (AC-057.5)."""
    s = _testing_section(prd, "Harness")
    body = s.body if s else []
    out = []
    for i, (_, text) in enumerate(body):
        m = _SLOT.match(text)
        if not m:
            continue
        parts = [m.group(2)]
        for _, nxt in body[i + 1:]:
            if nxt[:1] == " " and nxt.strip():
                parts.append(nxt)
            else:
                break
        slot = m.group(1)
        out.append(Item(slot, (slot, _collapse(" ".join(parts)))))
    return out


def standards(prd: model.Prd) -> list[Item]:
    """One item per section 5 row whose Decision, the fifth cell, is enforced (AC-057.6)."""
    out = []
    for r in _rows(prd, 5):
        if len(r.cells) >= 5 and cell(r.cells[4]) == "enforced":
            glob = cell(r.cells[0])
            out.append(Item(glob, (glob, _first_span(r.cells[1]))))
    return out


def skills(prd: model.Prd) -> list[Item]:
    """One item per section 6 row whose Decision, the third cell, is required or recommended (AC-057.6)."""
    out = []
    for r in _rows(prd, 6):
        if len(r.cells) >= 3 and cell(r.cells[2]) in ("required", "recommended"):
            activity = cell(r.cells[0])
            out.append(Item(activity, (activity, cell(r.cells[1]))))
    return out


def paired(a: list[Item], b: list[Item]) -> list[tuple[str, Item]]:
    """(mark, item) lines: A's items in A's order, each `both`, or `A` then its differing pair `B`, or `A` alone; then
    B's unpaired items in B's order (AC-057.7). The n-th item of a key in A pairs with the n-th of that key in B."""
    by_key: dict[str, list[Item]] = {}
    for item in b:
        by_key.setdefault(item.key, []).append(item)
    seen: dict[str, int] = {}
    used: set[int] = set()
    out: list[tuple[str, Item]] = []
    for item in a:
        n = seen.get(item.key, 0)
        seen[item.key] = n + 1
        same_key = by_key.get(item.key, [])
        pair = same_key[n] if n < len(same_key) else None
        if pair is None:
            out.append(("A", item))
            continue
        used.add(id(pair))
        if pair.values == item.values:
            out.append(("both", item))
        else:
            out += [("A", item), ("B", pair)]
    out += [("B", item) for item in b if id(item) not in used]
    return out


def _target_count(prd: model.Prd, ctype: str) -> int:
    prefix = f"{ctype}:"
    return sum(1 for tc in prd.test_cases if isinstance(tc.data.get("target"), str) and tc.data["target"].startswith(prefix))


def target_kinds(a: model.Prd, b: model.Prd, types: list[tuple[str, Item]]) -> list[tuple[str, Item]]:
    """For each type the Contract types part names, in the order it first names it, that a test case uses (AC-057.3)."""
    out = []
    for name in dict.fromkeys(item.key for _, item in types):
        ca, cb = _target_count(a, name), _target_count(b, name)
        if ca or cb:
            out.append(("both" if ca and cb else ("A" if ca else "B"), Item(name, (name, ca, cb))))
    return out


def _language_words(prd: model.Prd) -> set[str]:
    """The EARS openers and the modal word of the PRD's language table, in lower case; none when no table reads."""
    table = languages.for_prd(prd)
    if table is None:
        return set()
    return {w.lower() for w in table.openers} | ({table.modal_word.lower()} if table.modal_word else set())


def _builtin_vocabulary() -> set[str]:
    from . import packs  # local: packs imports hooks

    out: set[str] = set()
    for name in BUILT_IN_PACKS:
        try:
            pack = packs.load_manifest(packs.toolkit_packs_dir() / name, packs.BUILT_IN)
        except (packs.ManifestError, OSError, ValueError):  # a built-in a vendored copy does not hold adds no word
            continue
        out.update(str(w).lower() for w in pack.vocabulary)
    return out


def _removed(status: str | None) -> bool:
    return (status or "").lower().startswith("removed")


def words(prd: model.Prd) -> dict[str, int]:
    """Each word's count in the titles of the UJ, FR and NFR blocks not removed and in the text of their ACs not
    removed, every code span removed first (AC-057.8)."""
    counts: dict[str, int] = {}
    for blk in prd.blocks:
        if _removed(blk.status):
            continue
        for text in [blk.title] + [ac.text for ac in blk.acs if not ac.removed]:
            for w in _WORD.findall(_CODE_SPAN.sub("", text)):
                w = w.lower()
                counts[w] = counts.get(w, 0) + 1
    return counts


def vocabulary(a: model.Prd, b: model.Prd) -> list[tuple[str, Item]]:
    left_out = _language_words(a) | _language_words(b) | _builtin_vocabulary()
    wa, wb = words(a), words(b)
    shared = [w for w in wa if w in wb and len(w) >= MIN_WORD and w not in left_out]
    shared.sort(key=lambda w: (-(wa[w] + wb[w]), w))
    return [("both", Item(w, (w, wa[w], wb[w]))) for w in shared]


def compare(a: model.Prd, b: model.Prd) -> dict[str, list[tuple[str, Item]]]:
    """Every part's lines, as (mark, item), keyed as the JSON document keys them; NothingShared when no contract type
    name is a custom contract type of both PRDs (AC-058.2)."""
    ta, tb = contract_types(a), contract_types(b)
    if not {i.key for i in ta} & {i.key for i in tb}:
        raise NothingShared()
    types = paired(ta, tb)
    return {
        "contract-types": types,
        "target-kinds": target_kinds(a, b, types),
        "levels": paired(levels(a), levels(b)),
        "harness": paired(harness(a), harness(b)),
        "standards": paired(standards(a), standards(b)),
        "skills": paired(skills(a), skills(b)),
        "vocabulary": vocabulary(a, b),
    }


def text(parts: dict[str, list[tuple[str, Item]]]) -> str:
    """The seven parts: `## <part>`, its lines or `None.`, then one empty line (AC-057.1)."""
    out = []
    for title, key in zip(PARTS, KEYS):
        out.append(f"## {title}")
        out += [item.line(key, mark) for mark, item in parts[key]] or ["None."]
        out.append("")
    return "".join(f"{line}\n" for line in out)


def document(a_arg: str, b_arg: str, parts: dict[str, list[tuple[str, Item]]]) -> dict:
    """The JSON payload after `interface` and `kind`: `a`, `b` and `parts`, a `-` value as null (AC-058.1)."""
    def obj(key: str, mark: str, item: Item) -> dict:
        values = [None if v == DASH else v for v in item.values]
        return {"mark": mark, **dict(zip(FIELDS[key], values))}

    return {"a": a_arg, "b": b_arg, "parts": {key: [obj(key, m, i) for m, i in parts[key]] for key in KEYS}}
