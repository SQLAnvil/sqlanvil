"""The status report: where every requirement of a PRD stands. Read-only and deterministic.

It reads the working trees of other repositories named by path-location links (and nothing else outside the repo);
git-URL links are not fetched here, so the report stays fast and offline.
"""
import json
import re
from dataclasses import asdict, dataclass, replace
from collections import Counter
from itertools import groupby
from pathlib import Path

from . import deploy, errors, hooks, trace
from .model import Prd, gate_of, git_toplevel

PARTS = ("Header", "Requirements", "Areas", "Adoption map", "Not built", "Not verified", "Open errors", "Upstreams", "Consumers", "Change sets", "CI", "Deployed", "Matrix")


@dataclass(frozen=True)
class StatusItem:
    part: str
    id: str | None
    text: str


def _requirements(prd: Prd) -> list[StatusItem]:
    counts: dict[str, dict[str, int]] = {}
    for b in prd.blocks:
        by = counts.setdefault(trace.area(b.file), {})
        status = b.status or "-"
        by[status] = by.get(status, 0) + 1
    order = sorted(counts, key=lambda a: (a == "nfr", list(counts).index(a)))
    return [StatusItem("Requirements", None, f"{a}: " + ", ".join(f"{s} {n}" for s, n in sorted(counts[a].items())))
            for a in order] or [StatusItem("Requirements", None, "None.")]


def _areas(prd: Prd) -> list[StatusItem]:
    from . import packs

    out = []
    for rel in prd.docs:
        m = re.fullmatch(r"features/([^/]+)\.md", rel)
        if m:
            ref, lang = packs.profile(prd, m.group(1))
            out.append(StatusItem("Areas", m.group(1), f"{m.group(1)}: pack {ref.name} {ref.version or '(default)'}, output language {lang}"))
    return out or [StatusItem("Areas", None, "None.")]


def _adoption(prd: Prd) -> list[StatusItem]:
    if prd.adoption is None:
        return [StatusItem("Adoption map", None, "Not applicable: new project")]
    rows = [StatusItem("Adoption map", r.area, f"{r.area} | {r.state} | {', '.join(r.boundary) or '-'}") for r in prd.adoption]
    return rows or [StatusItem("Adoption map", None, "None.")]


def _by_status(prd: Prd, part: str, status: str) -> list[StatusItem]:
    rows = [StatusItem(part, b.id, f"{b.id} {b.title} ({b.file})") for b in prd.blocks if b.status == status]
    return rows or [StatusItem(part, None, "None.")]


def _open_errors(prd: Prd) -> list[StatusItem]:
    rows = [StatusItem("Open errors", e.id, f"{e.id} {errors.summary(e)} — {e.title}") for e in prd.errors_ledger.values() if e.open]
    return rows or [StatusItem("Open errors", None, "None.")]


def _is_url(row) -> bool:
    from . import links
    try:
        return links.parse_location(row.location).url is not None
    except links.BadArgument:
        return False  # malformed: the check reports it


def _upstreams(prd: Prd) -> list[StatusItem]:
    if prd.links is None or not prd.links.upstreams:
        return [StatusItem("Upstreams", None, "None.")]
    from . import links
    # path locations only: status stays fast and offline; a git URL is left to prd_links.py check
    local = replace(prd, links=replace(prd.links, upstreams=[r for r in prd.links.upstreams if not _is_url(r)],
                                       consumers=[r for r in prd.links.consumers if not _is_url(r)]))
    try:
        lines, error = links.check(local), None
    except (links.Refused, links.Unreachable, links.BadArgument, links.GitMissing) as e:  # GitMissing: the machine's, not a bug
        lines, error = [], str(e)
    out = []
    for row in prd.links.upstreams:
        text = f"{row.name} {row.version or '-'} at {row.commit or '-'}, needs {row.needs.strip() or 'default'}"
        mine = [x for x in lines if x.side == "upstream" and x.name == row.name]
        if _is_url(row):
            text += ", check: not run (git URL; run prd_links.py check)"
        elif error is not None:
            text += f", check: error ({error})"
        elif not any(x.verdict == "unreachable" for x in mine):
            counts = Counter(x.verdict for x in mine)
            text += ", check: " + (", ".join(f"{v} {counts[v]}" for v in sorted(counts)) or "no items")
        out.append(StatusItem("Upstreams", row.name, text))
    return out


def _consumers(prd: Prd) -> list[StatusItem]:
    rows = [StatusItem("Consumers", r.name, f"{r.name} {r.location.strip('`')}") for r in prd.links.consumers] if prd.links else []
    return rows or [StatusItem("Consumers", None, "None.")]


def _change_sets(prd: Prd) -> list[StatusItem]:
    rows = [StatusItem("Change sets", cs.id, f"{cs.id} {cs.status}: " + "; ".join(f"{r.prd} {r.state}" for r in cs.rows))
            for cs in prd.change_sets.values() if cs.status not in ("done", "abandoned")]
    return rows or [StatusItem("Change sets", None, "None.")]


def _ci(prd: Prd, repo_root: Path) -> list[StatusItem]:
    if git_toplevel(prd.root) is None:
        return [StatusItem("CI", None, hooks.not_a_checkout(prd))]
    lines = hooks.stale_ci(repo_root, prd, deploy.prd_rel(prd, repo_root))
    return [StatusItem("CI", None, line) for line in lines] or [StatusItem("CI", None, "None.")]


def _stopped(prd: Prd, repo_root: Path, env: str, after: str | None) -> str | None:
    """`run <id> stopped (<state>) at step <N>` for the newest usable log of this PRD that touches `env` and did not finish it."""
    try:
        run_ids = sorted((p.stem for p in deploy.log_dir(repo_root).glob("*.jsonl")), reverse=True)
        mine = deploy.prd_rel(prd, repo_root)
    except Exception:
        return None
    for run_id in run_ids:
        if after and run_id <= after:
            break
        try:
            log = deploy.read_log(repo_root, run_id)
            if not log or log[0].get("kind") != "header" or log[0].get("prd") != mine:
                continue  # another PRD's run, or a log too old to name its PRD
            touched = [r for r in log if r.get("kind") in ("start", "step") and r.get("env") == env]
            if not touched:
                continue
            if env in deploy.finished_envs(log, prd):
                return None
            last = touched[-1]
            state = "unfinished" if last["kind"] == "start" else {"human": "human", "fail": "failed"}.get(last.get("result"), "unfinished")
            return f"run {run_id} stopped ({state}) at step {last['step']}"
        except Exception:
            continue
    return None


def _deployed(prd: Prd, repo_root: Path) -> list[StatusItem]:
    ops = prd.operations
    rows = {r.env: r for r in ops.deployed}
    names = list(ops.environments) + [e for e in rows if e not in ops.environments]
    out = []
    for env in names:
        row = rows.get(env)
        if row:
            out.append(StatusItem("Deployed", env, f"{env}: {row.version} at {row.commit}, {row.date}"))
        stopped = _stopped(prd, repo_root, env, row.run if row else None)
        if stopped:
            out.append(StatusItem("Deployed", env, f"{env}: {stopped}"))
    return out or [StatusItem("Deployed", None, "None.")]


def _matrix(prd: Prd, repo_root: Path) -> list[StatusItem]:
    cited = trace.citations(prd, repo_root)
    rows = []
    for b in prd.blocks:
        cells = [f"{t} {level} {gate_of(prd, level) or '-'} {'cited' if t in cited else 'missing'}" for t, level, _ in b.tests]
        rows.append(StatusItem("Matrix", b.id, f"{b.id}: " + ("; ".join(cells) or "no tests")))
    return rows or [StatusItem("Matrix", None, "None.")]


def build_status(prd: Prd, repo_root: Path, display: str = "") -> list[StatusItem]:
    header = StatusItem("Header", None, f"PRD: {display or prd.root.as_posix()}\n"
                        f"version {prd.frontmatter.get('version', '-')}\nstatus {prd.frontmatter.get('status', '-')}")
    return ([header] + _requirements(prd) + _areas(prd) + _adoption(prd) + _by_status(prd, "Not built", "approved")
            + _by_status(prd, "Not verified", "built") + _open_errors(prd) + _upstreams(prd)
            + _consumers(prd) + _change_sets(prd) + _ci(prd, repo_root) + _deployed(prd, repo_root) + _matrix(prd, repo_root))


def render_text(items: list[StatusItem]) -> str:
    return "\n".join(f"## {part}\n\n" + "\n".join(i.text for i in group) + "\n"
                     for part, group in groupby(items, key=lambda i: i.part))


def render_json(items: list[StatusItem]) -> str:
    return json.dumps([asdict(i) for i in items], indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def render_document(prd, items: list[StatusItem], first: list[dict] | None = None) -> str:
    """`first` is the Next part's items (FR-041), put before every other item."""
    from . import interface
    fm = prd.frontmatter
    return interface.dump("status", {"prd": fm.get("prd"), "version": fm.get("version"),
                                     "items": list(first or []) + [asdict(i) for i in items]})
