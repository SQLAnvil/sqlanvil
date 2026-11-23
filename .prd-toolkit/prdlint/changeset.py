"""The change-set record, `changes/CS-nnn.md`, and its only writer, behind prd_links.py changeset (prd-toolkit 0.7).

`new` reads every member's links.md from its working tree (members are path locations, so a clone on this machine)
and orders them upstream first, each row's Version read from the member's default branch, where its change-set
branch is cut; each later command reads the record alone, changes it, and writes it back whole in
the grammar `change-sets` checks. Free text (a title, a reply, a reason, a Log line) is kept to one line: its line
breaks collapse to single spaces. Today's date is `PRD_LINKS_TODAY` when set, so a test can fix it.
"""
import datetime
import heapq
import os
import re
import tempfile
from pathlib import Path

from . import model
from .links import BadArgument, Refused, Side, open_side, parse_location, toplevel
from .markdown import frontmatter
from .rules.links import _VERSION

HEADER = "| " + " | ".join(model._CS_HEADER) + " |"
SEPARATOR = "|" + "---|" * len(model._CS_HEADER)
NONE = "—"
FIELDS = ("branch", "version", "ids", "state")
_RECORD = re.compile(r"CS-(\d{3})\.md")
_BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*")
_ID = re.compile(r"(?:UJ|FR|NFR)-\d+")
_ENV = r"[A-Za-z0-9_.-]+"  # an environment name the table can hold: no `|`, `;`, blank or backtick
_STATE = re.compile(rf"(?:proposed|approved|built|verified|live in {_ENV})")
_NEED = re.compile(rf"(?:verified|live in {_ENV})")
_UNSAFE = re.compile(r"[|`\n\r]")  # what a backticked table cell cannot hold


# ---------------------------------------------------------------- small rules

def today() -> str:
    v = os.environ.get("PRD_LINKS_TODAY", "").strip()
    if not v:
        return datetime.date.today().isoformat()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) and datetime.date.fromisoformat(v):
            return v
    except ValueError:
        pass
    raise BadArgument(f"PRD_LINKS_TODAY {v!r}: must be YYYY-MM-DD")


def one_line(text: str) -> str:
    """`text` on one line: each line break, with the blanks around it, becomes one space."""
    return " ".join(p.strip() for p in str(text).splitlines() if p.strip())


def slug(title: str) -> str:
    """R-P2: lowercase; each run of non-alphanumerics one `-`; edges stripped; cut to 40; a trailing `-` stripped again."""
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40].rstrip("-")


def rank(state: str) -> int:
    return model.STATES.index(state) if state in model.STATES else len(model.STATES)  # `live in <env>` is the last


_LIVE = "live in "


def _env_at(envs: list[str], env: str, prd: str) -> int:
    if env not in envs:
        raise Refused(f"{prd}'s operations.md Environments has no {env}")
    return envs.index(env)


def holds(state: str, need: str, envs, prd: str) -> bool:
    """R-F1: a need `verified` holds for `verified` or any `live in`; a need `live in <e1>` for `live in <e2>` with e2 at
    or after e1 in `prd`'s operations.md Environments order (`envs()`, read only when both are `live in`)."""
    if need == "verified":
        return state == "verified" or state.startswith(_LIVE)
    if not state.startswith(_LIVE):
        return False
    order = envs()
    return _env_at(order, state.removeprefix(_LIVE), prd) >= _env_at(order, need.removeprefix(_LIVE), prd)


def _past(state: str, target: str, envs, prd: str) -> bool:
    """R-F4: `state` is beyond `target` (the furthest the change set needs): a higher rank, or a `live in` environment
    after the Target's in `prd`'s Environments order (`envs()`, read only when both are `live in`)."""
    if rank(state) != rank(target):
        return rank(state) > rank(target)
    if not state.startswith(_LIVE):
        return False
    order = envs()
    return _env_at(order, state.removeprefix(_LIVE), prd) > _env_at(order, target.removeprefix(_LIVE), prd)


def default_needs(prd: model.Prd) -> str:
    """An empty Needs: `live in` the Environment of the first deploy-gate level in testing.md Levels order, else `verified`."""
    for level in sorted(prd.testing.levels, key=prd.testing.levels.get):
        if model.gate_of(prd, level) == "deploy":
            env = prd.testing.level_envs.get(level, "")
            return f"live in {env}" if env else "verified"
    return "verified"


def _later(up: model.Prd, slug_: str, a: str, b: str) -> str:
    """The higher of two Needs of `up`: `live in` beats `verified`; of two environments, the later in its operations.md table."""
    if a == b or b == "verified":
        return a
    if a == "verified":
        return b
    envs = sorted(up.operations.environments, key=up.operations.environments.get)
    ea, eb = a.removeprefix("live in "), b.removeprefix("live in ")
    missing = [e for e in (ea, eb) if e not in envs]
    if missing:
        raise Refused(f"{slug_}'s operations.md Environments has no {missing[0]}, so its Target between {a} and {b} is unknown")
    return a if envs.index(ea) > envs.index(eb) else b


# ---------------------------------------------------------------- new

def _base_version(side: Side, working: str) -> str:
    """The member's `version:` on its default branch, where the change-set branch is cut: step 1 leaves the change's
    edits (a bump among them) in the starting tree before `new`. The working tree's when that branch has no PRD."""
    text = side.show(side.default_branch(), f"{side.folder}/prd.md")
    return frontmatter(text)[0].get("version", "") if text is not None else working


def _members(prd: model.Prd, given: list[str]) -> dict[str, tuple[model.Prd, str, str]]:
    """slug -> (the member's PRD, its backticked Location relative to the starting repository's root, its version on
    its default branch); the start first."""
    here = toplevel(prd.root).resolve()
    start = prd.frontmatter.get("prd", "")
    me = Side(parse_location("`.`"), here, prd.root.resolve(), start)
    out = {start: (prd, "`.`", _base_version(me, prd.frontmatter.get("version", "")))}
    for raw in given:
        cell = raw.strip()
        loc = parse_location(cell if cell.startswith("`") else f"`{cell}`")
        if loc.url is not None:
            raise Refused(f"{loc.raw.strip('`')} is not cloned on this machine")
        if (here / loc.path).resolve() == here:
            continue
        with open_side(here, loc) as side:
            other = side.load(None)
            name = side.slug
            rel = f"`{Path(os.path.relpath(side.repo, here)).as_posix()}`"
            base = _base_version(side, other.frontmatter.get("version", ""))
        if _UNSAFE.search(rel[1:-1]):
            raise Refused(f"{rel} cannot be written into the record table")
        if name in out:
            if out[name][0].root != other.root:
                raise Refused(f"two members hold PRD {name}: {out[name][1]} and {rel}")
            continue
        out[name] = (other, rel, base)
    return out


def _cycle(nodes: list[str], down: dict[str, list[str]]) -> list[str] | None:
    state: dict[str, int] = {}  # 1 on the path, 2 done

    def visit(n: str, path: list[str]) -> list[str] | None:
        state[n] = 1
        path.append(n)
        for d in down[n]:
            if state.get(d) == 1:
                return path[path.index(d):] + [d]
            if d not in state and (found := visit(d, path)):
                return found
        path.pop()
        state[n] = 2
        return None

    for n in nodes:
        if n not in state and (found := visit(n, [])):
            return found
    return None


def new(prd: model.Prd, title: str, members: list[str]) -> Path:
    """Write `changes/CS-nnn.md` (the highest number + 1) with every member in Order; returns its path."""
    title = one_line(title)
    if not title:
        raise BadArgument("--title is empty")
    branch_slug = slug(title)
    if not branch_slug:
        raise BadArgument(f"--title {title!r} has no letter or digit to name the branch")
    found = _members(prd, members)
    names = sorted(found)
    need: dict[tuple[str, str], str] = {}  # (upstream, downstream) -> the downstream's Needs of it
    for d in names:
        member = found[d][0]
        for r in member.links.upstreams if member.links else []:
            if r.name in found and r.name != d:
                value = r.needs.strip() or default_needs(member)
                if not _NEED.fullmatch(value):
                    raise Refused(f"{value} cannot be written into the record table")
                need[(r.name, d)] = value
    down = {n: sorted(d for u, d in need if u == n) for n in names}
    for n in found:  # the start first, then the members as given
        if not any(n in pair for pair in need):
            raise Refused(f"{n} is linked to no other member")
    cycle = _cycle(names, down)
    if cycle:
        raise Refused(f"the members' links form a cycle: {' → '.join(cycle)}")
    indegree = {n: sum(1 for u, d in need if d == n) for n in names}
    ready = [n for n in names if indegree[n] == 0]
    heapq.heapify(ready)
    order: list[str] = []
    while ready:
        n = heapq.heappop(ready)
        order.append(n)
        for d in down[n]:
            indegree[d] -= 1
            if indegree[d] == 0:
                heapq.heappush(ready, d)

    folder = prd.root / model.CHANGES_DIR
    taken = [int(m.group(1)) for p in (folder.iterdir() if folder.is_dir() else []) if (m := _RECORD.fullmatch(p.name))]
    number = max(taken, default=0) + 1
    if number > 999:
        raise Refused("changes/ already holds CS-999; the record numbers have run out")
    cid = f"CS-{number:03d}"
    rows = []
    for i, n in enumerate(order, 1):
        member, cell, version = found[n]
        if not _VERSION.fullmatch(version):
            raise Refused(f"{n} has no X.Y.Z version (found {version!r})")
        ups = [u for u in order if (u, n) in need]
        waits = "; ".join(f"{u} {need[(u, n)]}" for u in ups) or NONE
        target = "verified"
        for d in order:
            if (n, d) in need:
                target = _later(member, n, target, need[(n, d)])
        rows.append(model.ChangeRow(str(i), n, cell, f"cs-{number:03d}-{branch_slug}", version, NONE, waits, target, "proposed", 0))
    cs = model.ChangeSet(cid, f"{model.CHANGES_DIR}/{cid}.md", title, 1, started=f"{today()} in {prd.frontmatter.get('prd', '')}",
                         status="proposed", rows=rows)
    folder.mkdir(exist_ok=True)
    return _write(folder / f"{cid}.md", cs)


# ---------------------------------------------------------------- the record

def render(cs: model.ChangeSet) -> str:
    out = [f"# {cs.id} {cs.title}", "", f"Started: {cs.started}", f"Status: {cs.status}"]
    out += [f"Approval: {a}" for a in cs.approvals]
    out += ["", HEADER, SEPARATOR]
    for r in cs.rows:
        cells = [r.order, r.prd, r.location, r.branch, r.version, r.ids, r.waits_for, r.target, r.state]
        out.append("| " + " | ".join(cells) + " |")
    out += ["", "## Log", ""] + [f"- {x}" for x in cs.log]
    if cs.merge_order:
        out += ["", "## Merge order", ""] + [f"{i}. {x}" for i, x in enumerate(cs.merge_order, 1)]
    return "\n".join(out).rstrip("\n") + "\n"


def load(record: str | Path) -> tuple[Path, model.ChangeSet]:
    """The record at `record` (a `changes/CS-nnn.md` path), refused unless it reads back clean."""
    path = Path(record)
    if not _RECORD.fullmatch(path.name) or path.parent.name != model.CHANGES_DIR:
        raise BadArgument(f"{record}: a record is <PRD>/{model.CHANGES_DIR}/CS-nnn.md")
    if not path.is_file():
        raise Refused(f"no record {record}")
    cs = model._change_set(f"{model.CHANGES_DIR}/{path.name}", path.read_text(encoding="utf-8"))
    problems = list(cs.problems)
    for label, value in (("Started", cs.started), ("Status", cs.status)):
        if not value:
            problems.append((1, f"no {label}: line"))
    if cs.status and not model._CS_STATUS.match(cs.status):  # the parser leaves these to the change-sets rule
        problems.append((1, f"status '{cs.status}' is outside the grammar"))
    for r in cs.rows:
        for label, value in (("target", r.target), ("state", r.state)):
            if not model._CS_STATE.match(value):
                problems.append((r.line, f"row {r.prd}: {label} '{value}' is outside the grammar"))
    if not cs.rows:
        problems.append((1, "no rows"))
    if problems:
        n, msg = problems[0]
        raise Refused(f"{record} is not a record this script wrote: line {n}: {msg}")
    return path, cs


def _open(cs: model.ChangeSet) -> None:
    if cs.status in ("done", "abandoned"):
        raise Refused(f"{cs.id} is {cs.status}")


def _row(cs: model.ChangeSet, prd: str) -> model.ChangeRow:
    row = next((r for r in cs.rows if r.prd == prd), None)
    if row is None:
        raise Refused(f"{cs.id} has no row {prd}")
    return row


def _text(value: str, what: str) -> str:
    v = one_line(value)
    if not v:
        raise BadArgument(f"{what} is empty")
    return v


def _write(path: Path, cs: model.ChangeSet) -> Path:
    """Write the record whole: a temporary file beside it, then os.replace, so an interrupted write leaves the old one."""
    if path.exists():
        mode = path.stat().st_mode & 0o7777
    else:
        mask = os.umask(0)
        os.umask(mask)
        mode = 0o666 & ~mask
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(render(cs))
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path


# ---------------------------------------------------------------- the commands on a record

def _env_order(path: Path, cs: model.ChangeSet, prd: str):
    """A function giving member `prd`'s operations.md Environments, in table order, read once from its working tree
    through the row's Location (relative to the starting repository's root, where the record is)."""
    found: list[list[str]] = []

    def envs() -> list[str]:
        if not found:
            row = _row(cs, prd)
            try:
                loc = parse_location(row.location)
            except BadArgument as e:
                raise Refused(f"{cs.id} row {prd}: {e}") from None
            if loc.url is not None:
                raise Refused(f"{loc.raw.strip('`')} is not cloned on this machine")
            with open_side(toplevel(path.parent.resolve()).resolve(), loc, expect=prd) as side:
                table = side.load(None).operations.environments
            found.append(sorted(table, key=table.get))
        return found[0]

    return envs


def set_fields(record: str | Path, prd: str, assignments: list[str]) -> Path:
    """Set Branch, Version, IDs or State of row `prd`; a State moves Status to running. A State never goes back,
    never past the row's Target (R-F4), and never skips its Waits for."""
    parsed = []
    for a in assignments:
        key, eq, value = a.partition("=")
        key, value = key.strip().lower(), one_line(value)
        if not eq or key not in FIELDS:
            raise BadArgument(f"{a!r}: give {', '.join(f + '=<value>' for f in FIELDS)}")
        if key == "branch" and not (_BRANCH.fullmatch(value) and ".." not in value):
            raise BadArgument(f"branch {value!r}: must be a branch name without spaces")
        if key == "version" and not _VERSION.fullmatch(value):
            raise BadArgument(f"version {value!r}: must be X.Y.Z")
        if key == "ids":
            ids = [] if value in ("", NONE, "-") else [x.strip() for x in value.split(",")]
            if not all(_ID.fullmatch(x) for x in ids):
                raise BadArgument(f"ids {value!r}: must be comma-separated UJ-, FR- or NFR- IDs, or —")
            value = ", ".join(ids) or NONE
        if key == "state" and not _STATE.fullmatch(value):
            raise BadArgument(f"state {value!r}: must be proposed, approved, built, verified or live in <env>, "
                              "the environment a name of letters, digits, `_`, `.` or `-`")
        parsed.append((key, value))
    path, cs = load(record)
    _open(cs)
    row = _row(cs, prd)
    for key, value in parsed:
        if key == "branch":
            row.branch = value
        elif key == "version":
            current = row.version.split(" → ")[0]
            row.version = current if value == current else f"{current} → {value}"
        elif key == "ids":
            row.ids = value
        else:
            if cs.status == "proposed":
                raise Refused(f"{cs.id} is not approved yet")
            if rank(value) < rank(row.state):
                raise Refused(f"{prd} cannot go back from {row.state} to {value}")
            own = _env_order(path, cs, prd)
            if value.startswith(_LIVE) and row.state.startswith(_LIVE) and not holds(value, row.state, own, prd):
                raise Refused(f"{prd}: {value} is before {row.state}")
            if _past(value, row.target, own, prd):
                raise Refused(f"{prd}: {value} is past its Target {row.target}")
            if rank(value) >= rank("built") and row.waits_for != NONE:
                for wait in row.waits_for.split(";"):
                    up, _, need = wait.strip().partition(" ")
                    up_row = _row(cs, up)
                    if not holds(up_row.state, need, _env_order(path, cs, up), up):
                        raise Refused(f"{prd} waits for {up} {need}; {up} is {up_row.state}")
            row.state = value
            cs.status = "running"
    return _write(path, cs)


def approve(record: str | Path, reply: str, amendment: bool = False) -> Path:
    """Quote the reply on one Approval line; every proposed row and Status become approved (so an --amendment moves a
    running or stopped record back to approved, until the next `set` of a State)."""
    reply = _text(reply, "--reply")
    path, cs = load(record)
    _open(cs)
    if amendment and not cs.approvals:
        raise Refused(f"{cs.id} has no approval to amend")
    if not amendment and cs.status != "proposed":
        raise Refused(f"{cs.id} is {cs.status}, not proposed; a later approval is an --amendment")
    cs.approvals.append(f'{today()}, "{reply}"' + (" (amendment)" if amendment else ""))
    for r in cs.rows:
        if r.state == "proposed":
            r.state = "approved"
    cs.status = "approved"
    return _write(path, cs)


def stop(record: str | Path, prd: str, reason: str) -> Path:
    """Status `stopped: <prd>: <reason>` and a Log line; the row keeps its State."""
    reason = _text(reason, "the reason")
    path, cs = load(record)
    _open(cs)
    _row(cs, prd)
    cs.status = f"stopped: {prd}: {reason}"
    cs.log.append(f"{today()} {prd} stopped: {reason}")
    return _write(path, cs)


def log(record: str | Path, text: str) -> Path:
    text = _text(text, "the Log text")
    path, cs = load(record)
    cs.log.append(f"{today()} {text}")
    return _write(path, cs)


def close(record: str | Path) -> Path:
    """Refused unless every row's State equals its Target; Status done and the Merge order, in Order."""
    path, cs = load(record)
    _open(cs)
    for r in cs.rows:
        if r.state != r.target:
            raise Refused(f"{cs.id}: {r.prd} is {r.state}, not its target {r.target}")
    cs.status = "done"
    cs.log.append(f"{today()} closed: every row reached its target")
    cs.merge_order = [f"{r.prd} ({r.branch})" for r in cs.rows]
    return _write(path, cs)


def abandon(record: str | Path, reason: str) -> Path:
    """Status abandoned and a Log line; the branches are left for the user."""
    reason = _text(reason, "the reason")
    path, cs = load(record)
    _open(cs)
    cs.status = "abandoned"
    cs.log.append(f"{today()} abandoned: {reason}")
    return _write(path, cs)
