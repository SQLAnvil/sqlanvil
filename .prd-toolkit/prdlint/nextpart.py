"""The Next part of the status report (FR-040 to FR-047): what the PRD needs next, in order, each item listed once.

Read-only: it fetches nothing, runs lint and trace in this process, and reads no repository other than the ones the
status report already reads."""
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import gates, registry, trace
from .model import Prd, git_toplevel

PART = "Next"
BUILD = "/prd-toolkit:prd-build"
DEPLOY = "/prd-toolkit:prd-deploy"
_STOPPED = re.compile(r"run (\S+) stopped \((unfinished|failed|human)\) at step (\S+)")
_AWAITING = re.compile(r"awaiting (\S.*)")
_VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")


@dataclass(frozen=True)
class NextItem:
    kind: str
    text: str
    id: str | None = None
    ids: list[str] = field(default_factory=list)
    area: str | None = None
    command: str | None = None
    waits_on: str | None = None

    def to_dict(self) -> dict:
        return {"part": PART, "id": self.id, "text": self.text, "kind": self.kind, "ids": list(self.ids),
                "area": self.area, "command": self.command, "waits_on": self.waits_on}


def _sentence(text: str) -> str:
    """FR-047: a sentence whose inserted text already ends in `.`, `?` or `!` gets no full stop of its own."""
    return text if text.endswith((".", "?", "!")) else text + "."


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def _finding_line(f) -> str:
    return f"{f.file}:{f.line}: {f.rule}: {f.message}"


def _lint(prd: Prd) -> list[NextItem]:
    """AC-043.1: lint's error findings, as `prd lint` runs it; findings of severity warn are neither counted nor named."""
    errors = [f for f in registry.run(prd, warnings=True) if f.severity != "warn"]
    if not errors:
        return []
    n = len(errors)
    text = _sentence(f"Lint reports {n} {_plural(n, 'error', 'errors')}; the first is {_finding_line(errors[0])}")
    return [NextItem("lint", text, waits_on="agent")]


def _trace(prd: Prd, repo_root: Path) -> list[NextItem]:
    """AC-043.2: trace with no range, only inside a git checkout."""
    if git_toplevel(prd.root) is None:
        return []
    findings = trace.run_trace(prd, repo_root, None)
    if not findings:
        return []
    n = len(findings)
    text = _sentence(f"Trace reports {n} {_plural(n, 'finding', 'findings')}; the first is {_finding_line(findings[0])}")
    return [NextItem("lint", text, waits_on="agent")]


def _deploy_stopped(status_items, listed: list) -> list[NextItem]:
    """AC-043.3: each stopped run of the Deployed part whose run has no deploy-step gate (AC-042.3)."""
    out = []
    for item in status_items:
        if item.part != "Deployed" or not item.id or not item.text.startswith(f"{item.id}: "):
            continue
        rest = item.text[len(item.id) + 2:]
        m = _STOPPED.fullmatch(rest)
        if not m or any(g.id.startswith(f"deploy-step:{m.group(1)}:") for g in listed):
            continue
        out.append(NextItem("deploy-stopped", _sentence(f"The deploy to {item.id} stopped: {rest}"), command=DEPLOY, waits_on="agent"))
    return out


def _error_number(eid: str) -> int:
    return int(eid.split("-", 1)[1])


def _error_open(prd: Prd) -> list[NextItem]:
    """AC-043.4, AC-042.2: open entries `unclassified` or `confirmed`; a `proposed` one is its gate's item."""
    entries = sorted((e for e in prd.errors_ledger.values() if e.open and e.state in ("unclassified", "confirmed")),
                     key=lambda e: _error_number(e.id))
    return [NextItem("error-open", _sentence(f"{e.id} is open ({e.state}): {e.title}"), id=e.id, ids=[e.id],
                     command=f"/prd-toolkit:prd-error {e.id}", waits_on="agent") for e in entries]


def _gate(listed: list) -> list[NextItem]:
    """AC-044.1: one item per gate `prd gates list` lists, in its order."""
    out = []
    for g in listed:
        key = g.id.split(":", 1)[1] if ":" in g.id else ""
        ids = [key] if g.kind in ("error-class", "signoff") else []
        area = key if g.kind == "adoption" else None
        out.append(NextItem("gate", f"{g.title} waits for your answer.", id=g.id, ids=ids, area=area, waits_on="you"))
    return out


def _section(prd: Prd, number: int):
    return next((s for s in prd.sections if s.number == number), None)


def _open_questions(prd: Prd) -> list[str]:
    """AC-044.2: section 13's questions; a `- ` line begins one, its space-indented following lines continue it, and
    each question's text is taken without the white space at its start and at its end."""
    sec = _section(prd, 13)
    out: list[str] = []
    continuing = False
    for _, line in sec.body if sec else []:
        if line.startswith("- "):
            out.append(line[2:])
            continuing = True
        elif continuing and line.startswith(" ") and line.strip():
            out[-1] = f"{out[-1]} {line.lstrip(' ')}"
        elif line.strip() and line.strip() != "None.":
            out.append(line)
            continuing = False
        else:
            continuing = False
    return [q.strip() for q in out]


def _question(prd: Prd) -> list[NextItem]:
    """AC-044.2: assumptions awaiting someone, then section 13's open questions."""
    out = []
    for row in prd.assumptions:
        status = row.cells[2].strip("`") if len(row.cells) > 2 else ""
        m = _AWAITING.fullmatch(status)
        if not m:
            continue
        aid = row.cells[0].strip("`")
        out.append(NextItem("question", _sentence(f"{aid} waits on {m.group(1)}: {row.cells[1]}"), ids=[aid], waits_on="you"))
    for q in _open_questions(prd):
        out.append(NextItem("question", _sentence(f"An open question waits: {q}"), waits_on="you"))
    return out


def _draft(prd: Prd) -> list[NextItem]:
    """AC-044.3: a version below 1.0.0."""
    version = str(prd.frontmatter.get("version", "")).strip()
    m = _VERSION.fullmatch(version)
    if not m or tuple(int(x) for x in m.groups()) >= (1, 0, 0):
        return []
    return [NextItem("draft", f"The PRD is a draft at version {version}, not yet approved.", command="/prd-toolkit:prd-new",
                     waits_on="you")]


def _deploy(prd: Prd) -> list[NextItem]:
    """AC-045.1: verified blocks, when operations.md names an environment."""
    ids = [b.id for b in prd.blocks if b.status == "verified"]
    if not prd.operations.environments or not ids:
        return []
    n = len(ids)
    text = "1 requirement is verified and not live." if n == 1 else f"{n} requirements are verified and not live."
    return [NextItem("deploy", text, ids=ids, command=DEPLOY, waits_on="agent")]


def _areas(prd: Prd) -> list[str]:
    """The areas in the order the Requirements part lists them: first appearance, `nfr` last."""
    seen = list(dict.fromkeys(trace.area(b.file) for b in prd.blocks))
    return sorted(seen, key=lambda a: (a == "nfr", seen.index(a)))


def _joined(ids: list[str]) -> str:
    return ids[0] if len(ids) == 1 else ", ".join(ids[:-1]) + " and " + ids[-1]


def _per_area(prd: Prd, kind: str, status: str, words: str) -> list[NextItem]:
    """AC-045.2, AC-045.3: one item per area holding blocks of `status`."""
    out = []
    for a in _areas(prd):
        ids = [b.id for b in prd.blocks if b.status == status and trace.area(b.file) == a]
        if not ids:
            continue
        verb = "is" if len(ids) == 1 else "are"
        out.append(NextItem(kind, f"{_joined(ids)} {verb} {words}.", ids=ids, area=a,
                            command=" ".join([BUILD, a, *ids]), waits_on="agent"))
    return out


def _adopt(prd: Prd, listed: list) -> list[NextItem]:
    """AC-045.4: each adoption row not adopted whose area has no adoption gate."""
    gated = {g.id for g in listed}
    return [NextItem("adopt", f"Area {r.area} is not adopted ({r.state}).", area=r.area,
                     command=f"/prd-toolkit:prd-adopt {r.area}", waits_on="agent")
            for r in prd.adoption or [] if r.state != "adopted" and f"adoption:{r.area}" not in gated]


def _idle(prd: Prd) -> NextItem:
    """FR-046: nothing waits."""
    end = "live" if prd.operations.environments else "verified"
    return NextItem("idle", f"Nothing waits. Everything approved is {end}.")


def next_items(prd: Prd, repo_root: Path, status_items: list) -> list[NextItem]:
    """FR-042: Broken, then Waiting on you, then Work, by kind in AC-042.1's order; the idle item alone when none."""
    listed = gates.list_gates(prd, Path(repo_root), worktrees=False)
    items = (_lint(prd) + _trace(prd, Path(repo_root)) + _deploy_stopped(status_items, listed) + _error_open(prd)
             + _gate(listed) + _question(prd) + _draft(prd) + _deploy(prd)
             + _per_area(prd, "verify", "built", "built and not verified")
             + _per_area(prd, "build", "approved", "approved and not built") + _adopt(prd, listed))
    return items or [_idle(prd)]


def render_text(items: list[NextItem]) -> str:
    """AC-040.1: `## Next`, an empty line, `<n>. <text>` and `  run: <command>` per item, then an empty line."""
    lines = []
    for n, item in enumerate(items, 1):
        lines.append(f"{n}. {item.text}")
        if item.command:
            lines.append(f"  run: {item.command}")
    return f"## {PART}\n\n" + "\n".join(lines) + "\n\n"
