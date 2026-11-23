#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Write or refresh the managed prd-toolkit block in a repo's CLAUDE.md.
Exit 0 written or current, 1 stale or missing (--check), 2 usage or error."""
import argparse
import json
import os
import sys
import tempfile
import textwrap
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import model, overview  # noqa: E402
from prdlint.markdown import tables  # noqa: E402

START = "<!-- prd-toolkit:start -->"
END = "<!-- prd-toolkit:end -->"
_HERE = Path(__file__).resolve().parent
# vendored in .prd-toolkit/, the template sits beside the script; in the plugin it is one level up
TEMPLATE = _HERE / "templates/claude-block.md" if (_HERE / "templates/claude-block.md").is_file() else _HERE.parent / "templates/claude-block.md"


def _template(name: str) -> Path:
    return _HERE / f"templates/{name}" if (_HERE / f"templates/{name}").is_file() else _HERE.parent / f"templates/{name}"


README_TEMPLATE, PARENT_TEMPLATE = _template("readme-prd.md"), _template("readme-prds.md")
PLUGIN_JSON = _HERE.parent / ".claude-plugin/plugin.json"
VENDORED = _HERE.name == ".prd-toolkit"  # a vendored run: the script sits in the host repo's .prd-toolkit/
HOMEPAGE_FILE = _HERE / "HOMEPAGE"  # written by vendoring; beside the script in a vendored copy

FILES_TEXT = (
    ("prd.md", "The overview: goals, glossary, architecture, the requirement index, open questions, changelog"),
    ("features/", "One file per area: requirements (`FR-nnn`) and their acceptance criteria (`AC-nnn.n`)"),
    ("test-cases/", "The test cases for each criterion (`T-nnn.n`), which the tests cite"),
    ("contracts/", "The interfaces the code must match: commands, configuration, schemas, APIs"),
    ("testing.md", "How the tests are run, at which level and gate"),
    ("errors.md", "The error ledger: every bug, its class and its fix (`E-nnn`)"),
    ("operations.md", "Environments and the deploy runbook"),
    ("nfr.md", "Non-functional requirements (`NFR-nnn`)"),
    ("adoption.md", "Which areas of the existing code are under this PRD, and their state"),
    ("links.md", "The PRDs whose contracts this one uses or provides"),
)
NO_SUMMARY = "_No summary yet: prd.md §2 is empty._"
NO_HOMEPAGE = "Install the prd-toolkit plugin for Claude Code."


class BlockError(Exception):
    pass


class MarkerInSummary(BlockError):
    """Raised bare: the message names prd.md, not a target file."""


def _rows(prd: model.Prd, number: int):
    sec = next((s for s in prd.sections if s.number == number), None)
    if sec is None:
        return None, []
    return sec, [r for t in tables(sec.body) for r in t.rows]


def _required_skills(prd: model.Prd) -> str:
    _, rows = _rows(prd, 6)
    lines = []
    for r in rows:
        cells = [c.strip() for c in r.cells] + [""] * 3
        if cells[2].strip("`").strip() == "required":
            lines.append(f"- `{cells[1].strip('`').strip()}` for {cells[0]}")
    return "\n".join(lines) or "- none"


def _adopted_areas(prd: model.Prd) -> str:
    if prd.adoption is None:
        sec = next((s for s in prd.sections if s.number == 8), None)
        body = " ".join(t for _, t in sec.body) if sec else ""
        return "all (new project)" if "Not applicable: new project" in body else "none yet"
    return ", ".join(r.area for r in prd.adoption if r.state == "adopted") or "none yet"


# The change rule; with links.md it also names the coordination role, and the skill name gives way to keep the block small.
CHANGE_RULE = "`/prd-toolkit:prd-change` (`prd-toolkit:changing-prds`), before code"
CHANGE_RULE_SHORT = "`/prd-toolkit:prd-change`, before code"
CHANGE_RULE_LINKED = ("`/prd-toolkit:prd-change`, before code;\n"
                      "  one to a cited item, with `/prd-toolkit:prd-change-set`")


def change_line(prd: model.Prd) -> str:
    """The block's change sentence (no bullet, no trailing newline); on an adopted PRD it covers only the adopted areas.
    An adopted PRD's line is short (no skill name) and wrapped at 100 columns, to keep the block under 1,792 bytes."""
    if prd.adoption is None:
        return f"Every behaviour change starts with {CHANGE_RULE_LINKED if prd.links is not None else CHANGE_RULE}."
    rule = CHANGE_RULE_LINKED if prd.links is not None else CHANGE_RULE_SHORT
    text = f"Every behaviour change in an adopted area starts with {rule}."
    return textwrap.fill("- " + " ".join(text.split()), width=100, subsequent_indent="  ",
                         break_long_words=False, break_on_hyphens=False)[2:]


def render_block(prd: model.Prd, prd_rel: str) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    slots = {
        "change_line": change_line(prd),
        "prd_path": prd_rel,
        "version": prd.frontmatter.get("version", "unknown").strip(),
        "required_skills": _required_skills(prd),
        "adopted_areas": _adopted_areas(prd),
    }
    for k, v in slots.items():
        text = text.replace("{{" + k + "}}", v)
    return text.rstrip("\n")


def _closed_fences(lines: list[str]) -> set[int]:
    """Indexes of lines inside a closed fence (openers and closers included). An opener with no closer protects nothing."""
    inside: set[int] = set()
    i = 0
    while i < len(lines):
        t = lines[i].strip()
        if t.startswith("```") or t.startswith("~~~"):
            fence = t[0] * (len(t) - len(t.lstrip(t[0])))
            j = next((k for k in range(i + 1, len(lines))
                      if lines[k].strip().startswith(fence) and lines[k].strip().strip(fence[0]) == ""), None)
            if j is not None:
                inside.update(range(i, j + 1))
                i = j
        i += 1
    return inside


def _find_block(lines: list[str]) -> tuple[int, int] | None:
    skip = _closed_fences(lines)
    starts = [i for i, ln in enumerate(lines) if i not in skip and ln.strip() == START]
    ends = [i for i, ln in enumerate(lines) if i not in skip and ln.strip() == END]
    if not starts and not ends:
        return None
    if len(starts) > 1 or len(ends) > 1:
        raise BlockError("more than one prd-toolkit block")
    if len(starts) != 1 or len(ends) != 1 or ends[0] < starts[0]:
        raise BlockError("prd-toolkit start and end markers are unbalanced")
    return starts[0], ends[0]


def _merged(claude_md: Path, block: str, position: str = "end") -> tuple[str, str]:
    """(current text, new text); raises BlockError on bad markers."""
    current = claude_md.read_bytes().decode("utf-8") if claude_md.exists() else ""
    lines = current.splitlines(keepends=True)
    span = _find_block(lines)
    if span is None:
        if not current:
            return current, block + "\n"
        if position == "top":
            return current, block + "\n\n" + current
        sep = "\n\n" if not current.endswith("\n") else "\n"
        return current, current + sep + block + "\n"
    s, e = span
    eol = lines[e][len(lines[e].rstrip("\r\n")):]
    return current, "".join(lines[:s]) + block + eol + "".join(lines[e + 1:])


def homepage() -> str | None:
    """A vendored run reads only `.prd-toolkit/HOMEPAGE`; a plugin run reads the toolkit's own `plugin.json`
    (its name must be `prd-toolkit`, so a host repo's manifest is never taken). None when absent."""
    try:
        if VENDORED:
            line = HOMEPAGE_FILE.read_text(encoding="utf-8").strip() if HOMEPAGE_FILE.is_file() else ""
            return line.splitlines()[0].strip() if line else None
        if PLUGIN_JSON.is_file():
            data = json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))
            value = data.get("homepage")
            if data.get("name") == "prd-toolkit" and isinstance(value, str) and value.strip():
                return value.strip()
    except (OSError, ValueError, AttributeError):
        return None
    return None


def _cell(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def _location(loc: str) -> str:
    """A relative path as a link, anything else (a `<git URL>#<folder>`) as code."""
    bare = loc.strip().strip("`").strip()
    if not bare:
        return "-"
    if "://" in bare or bare.startswith("git@") or "#" in bare:
        return f"`{bare}`"
    return f"[{bare}]({quote(bare, safe='/.-_~')})"


def _fill(text: str, slots: dict[str, str]) -> str:
    for k, v in slots.items():
        text = text.replace("{{" + k + "}}", v)
    return text.rstrip("\n")


def _check_markers(block: str) -> None:
    try:
        span = _find_block(block.splitlines(keepends=True))
    except BlockError:
        span = None
    if span != (0, len(block.splitlines()) - 1):
        raise BlockError("the block holds a prd-toolkit marker of its own")


def render_readme(prd: model.Prd, parent_written: bool) -> str:
    f = overview.facts(prd)
    sec2 = next((x for x in prd.sections if x.number == 2), None)  # raw, comments included: the marker text must not be there at all
    if any(m in "\n".join(t for _, t in sec2.body) for m in (START, END)) if sec2 else False:
        raise MarkerInSummary("prd.md §2 holds a prd-toolkit marker")
    summary = "\n".join("> " + ln for ln in f.summary.split("\n")) if f.summary else NO_SUMMARY
    areas = ["| Area | Adoption | File |", "|---|---|---|"]
    areas += [f"| {a.name} | {a.adoption} | [{a.file}]({quote(a.file, safe='/.-_~')}) |" for a in f.areas]
    texts = dict(FILES_TEXT)
    files = ["| Path | Holds |", "|---|---|"] + [f"| `{p}` | {texts[p]} |" for p in f.files]
    links = ""
    if prd.links is not None:
        def listing(title: str, locs: list[str]) -> str:
            return f"**{title}**\n\n" + ("\n".join(f"- {_location(x)}" for x in locs) if locs else "- none")
        links = ("\n## Linked PRDs\n\n" + listing("Upstreams", f.upstreams) + "\n\n"
                 + listing("Consumers", f.consumers) + "\n")
    block = _fill(README_TEMPLATE.read_text(encoding="utf-8"), {
        "slug": f.slug, "version": f.version, "status": f.status, "owner": f.owner, "updated": f.updated,
        "parent_link": " (see [../README.md](../README.md) to set it up)" if parent_written else "",
        "summary": summary, "areas": "\n".join(areas), "files": "\n".join(files), "links": links,
    })
    _check_markers(block)
    return block


def render_parent(parent: Path, home: str | None) -> tuple[str, list[str]]:
    """The parent README's block and the stderr notes for siblings that do not load."""
    rows = ["| PRD | Version | Status | Covers |", "|---|---|---|---|"]
    notes: list[str] = []
    for d in sorted((p for p in parent.iterdir() if p.is_dir() and not p.name.startswith(".")), key=lambda p: p.name):
        if not (d / "prd.md").is_file():
            continue
        try:
            f = overview.facts(model.load(d))
        except Exception as e:  # any failure to read a sibling is one row, never a crash
            rows.append(f"| {_cell(d.name)} | - | could not be read | - |")
            notes.append(f"prd_block: {d.name}: could not be read ({type(e).__name__}: {e})")
            continue
        covers = _cell(f.first_sentence) or "-"
        rows.append(f"| [{_cell(d.name)}]({quote(d.name, safe='-_.~')}/) | {_cell(f.version)} | {_cell(f.status)} | {covers} |")
    text = PARENT_TEMPLATE.read_text(encoding="utf-8")
    if home is None:
        text = text.replace(": {{homepage}}", ".")
    block = _fill(text, {"prds": "\n".join(rows), "homepage": home or ""})
    _check_markers(block)
    return block, notes


Target = tuple[Path, str, str]  # (path, block, position): position "end" or "top"


def targets(prd: model.Prd, root: Path, claude_md: Path) -> list[Target]:
    try:
        rel = prd.root.relative_to(root.resolve()).as_posix()
    except ValueError:
        rel = prd.root.as_posix()
    out: list[Target] = [(claude_md, render_block(prd, rel), "end")]
    under_prd = prd.root.parent.name == "prd"
    out.append((prd.root / "README.md", render_readme(prd, under_prd), "top"))
    if under_prd:
        block, notes = render_parent(prd.root.parent, homepage())
        for n in notes:
            print(n, file=sys.stderr)
        out.append((prd.root.parent / "README.md", block, "top"))
    return out


def _merge_target(path: Path, block: str, position: str) -> tuple[str, str]:
    try:
        return _merged(path.resolve(), block, position)
    except BlockError as e:
        raise BlockError(f"{path}: {e}") from None


def stale(tgts: list[Target]) -> list[Path]:
    out = []
    for path, block, position in tgts:
        current, new = _merge_target(path, block, position)
        if new != current:
            out.append(path)
    return out


def write(tgts: list[Target]) -> list[Path]:
    """Write every target that differs; all merges are computed first, so a bad marker writes nothing."""
    plan = []
    for path, block, position in tgts:
        real = path.resolve()  # write through a symlink, never replace it
        current, new = _merge_target(real, block, position)
        if new != current:
            plan.append((path, real, new))
    for _, real, new in plan:
        _replace(real, new)
    return [p for p, _, _ in plan]


def _replace(real: Path, new: str) -> None:
    real.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=real.parent, prefix=f".{real.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(new.encode("utf-8"))
        if real.exists():
            os.chmod(tmp, real.stat().st_mode & 0o7777)
        os.replace(tmp, real)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def apply_block(claude_md: Path, block: str) -> bool:
    claude_md = claude_md.resolve()  # write through a symlink, never replace it
    current, new = _merged(claude_md, block)
    if new == current:
        return False
    _replace(claude_md, new)
    return True


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_block.py", description="Write the managed CLAUDE.md block.")
    parser.add_argument("prd_dir")
    parser.add_argument("--claude-md")
    parser.add_argument("--check", action="store_true")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    try:
        prd = model.load(Path(args.prd_dir))
        if prd.adoption_unmigrated:
            print(f"prd_block: {prd.root.as_posix()}/prd.md: {model.UNMIGRATED}", file=sys.stderr)
            return 2
        root = model.repo_root(prd.root)
        claude_md = Path(args.claude_md) if args.claude_md else root / "CLAUDE.md"
        tgts = targets(prd, root, claude_md)
        if args.check:
            base = root if model.git_toplevel(prd.root) else claude_md.resolve().parent
            old = stale(tgts)
            for path in old:
                try:
                    shown = path.resolve().relative_to(base.resolve()).as_posix()
                except ValueError:
                    shown = path.as_posix()
                print(f"stale: {shown}")
            return 1 if old else 0
        write(tgts)
        return 0
    except model.NotAPrd as e:
        print(f"prd_block: {e}", file=sys.stderr)
        return 2
    except MarkerInSummary as e:
        print(f"prd_block: {e}", file=sys.stderr)
        return 2
    except BlockError as e:
        print(f"prd_block: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_block: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # PRDs carry em dashes; never crash in a C locale
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
