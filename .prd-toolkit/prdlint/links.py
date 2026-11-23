"""The location reader and the links.md writers behind prd_links.py (prd-toolkit 0.7).

A Location is a links.md cell: a backticked path to another repository's root, or a backticked
`<git URL>#<PRD folder>`. `open_side` turns one into a Side, the other repository as git sees it: a
path on disk, or a bare partial clone of the URL under the cache. Every git call goes through `_git`,
with GIT_TERMINAL_PROMPT=0 and a timeout, so a location that cannot be read is Unreachable, never a
prompt or a hang. Reading a PRD at a ref copies its folder out of git into a temporary directory;
nothing is written under any `.git/` or inside a repository except the files a command names, and every
temporary directory goes when its Side is closed. `check` and `impact` only read: a side that cannot be read or
fetched, or lacks its default branch, is `unreachable` (exit 3 unless something drifted); one holding the wrong
PRD is refused.
"""
import hashlib
import os
import shutil
import signal
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Self

from . import citations, model, snapshot
from .markdown import frontmatter, split_cells
from .rules.contracts import event_names
from .rules.links import _LOCATION, _LOCATION_MSG, _NEEDS, _URL, _VERSION

UPSTREAM_HEADER = "| Upstream | Location | Version | Commit | Needs |"
CONSUMER_HEADER = "| Consumer | Location |"
SKELETON = (f"# Links\n\n## Upstreams\n\n{UPSTREAM_HEADER}\n|---|---|---|---|---|\n\n"
            f"## Consumers\n\n{CONSUMER_HEADER}\n|---|---|\n")


class Unreachable(Exception):
    """A location the script cannot read or fetch."""


class Refused(Exception):
    """The command will not do it; nothing was written."""


class NoRef(Refused):
    """A ref the other repository does not have."""


class BadArgument(ValueError):
    """A malformed location or Needs value: a usage error."""


class GitMissing(Exception):
    """git cannot run at all: a tool error (exit 2), never an unreachable side."""


# ---------------------------------------------------------------- git

def _timeout() -> float:
    try:
        return float(os.environ.get("PRD_LINKS_TIMEOUT") or 60)
    except ValueError:
        return 60.0


def _git(cwd: Path, *args: str, input: bytes | None = None) -> subprocess.CompletedProcess:
    """Run git in `cwd`: no terminal prompt (nor an ssh passphrase prompt, unless the user set GIT_SSH_COMMAND), no
    optional locks, bounded by the timeout. Raises Unreachable on a timeout and GitMissing when git cannot start; a
    non-zero exit is the caller's to judge."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    limit = _timeout()
    try:
        p = subprocess.Popen(["git", *args], cwd=cwd, env=env, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as e:
        raise GitMissing(f"git cannot run: {e}") from e
    try:
        out, err = p.communicate(input, timeout=limit)
    except subprocess.TimeoutExpired:
        try:  # the whole group: a transport helper or ssh holding the pipes would block the second communicate
            os.killpg(p.pid, signal.SIGKILL) if hasattr(os, "killpg") else p.kill()
        except (ProcessLookupError, PermissionError):
            p.kill()
        p.communicate()
        raise Unreachable(f"git {args[0]} timed out after {limit:g} s") from None
    return subprocess.CompletedProcess(["git", *args], p.returncode, out, err)


def _out(cwd: Path, *args: str, input: bytes | None = None, why: str = "") -> bytes:
    """git's stdout; Unreachable, prefixed with `why`, on a timeout or a non-zero exit."""
    try:
        r = _git(cwd, *args, input=input)
    except Unreachable as e:
        raise Unreachable(f"{why}: {e}" if why else str(e)) from None
    if r.returncode != 0:
        tail = r.stderr.decode("utf-8", "replace").strip().splitlines()
        msg = f"git {args[0]}: {tail[-1] if tail else f'exit {r.returncode}'}"
        raise Unreachable(f"{why}: {msg}" if why else msg)
    return r.stdout


def toplevel(path: Path) -> Path:
    """The repository root above `path`; `path` itself when git finds none."""
    try:
        r = _git(path, "rev-parse", "--show-toplevel")
    except Unreachable:
        return path
    out = r.stdout.decode("utf-8", "replace").strip()
    return Path(out) if r.returncode == 0 and out else path


# ---------------------------------------------------------------- locations

@dataclass
class Location:
    raw: str  # the cell as written, backticks included
    path: str | None  # a path location: the other repository's root, relative to this repository's root
    url: str | None  # a URL location: the git URL ...
    folder: str | None  # ... and the PRD folder it names


def parse_location(cell: str) -> Location:
    """A links.md Location cell; BadArgument (a ValueError) on anything links-format would reject."""
    raw = cell.strip()
    m = _LOCATION.fullmatch(raw)
    if not m:
        raise BadArgument(f"{cell!r}: {_LOCATION_MSG}")
    loc = m.group(1)
    if _URL.match(loc):
        url, _, folder = loc.partition("#")
        folder = folder.strip().strip("/")
        if not folder or not url.strip():
            raise BadArgument(f"{cell!r}: {_LOCATION_MSG}")
        return Location(raw, None, url.strip(), folder)
    return Location(raw, loc, None, None)


def _cache_dir(url: str) -> Path:
    xdg = os.environ.get("XDG_CACHE_HOME", "")
    base = Path(xdg) if xdg and Path(xdg).is_absolute() else Path.home() / ".cache"  # a relative value is ignored, per XDG
    return base / "prd-toolkit/links" / hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


def _fetch(loc: Location) -> Path:
    """The URL's bare partial clone under the cache: cloned the first time, fetched after."""
    d = _cache_dir(loc.url)
    if (d / "HEAD").is_file():
        _out(d, "fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*",
             why=f"{loc.raw} is unreachable")
        return d
    d.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{d.name}.", dir=d.parent))
    try:
        _out(d.parent, "clone", "-q", "--bare", "--filter=blob:none", "--", loc.url, str(tmp), why=f"{loc.raw} is unreachable")
        try:
            tmp.rename(d)
        except OSError:  # another run cloned it first
            if not (d / "HEAD").is_file():
                raise
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
    return d


@dataclass
class Side:
    location: Location
    repo: Path  # the repository on disk, or the URL's cache clone
    prd_dir: Path  # repo / the PRD folder (for a URL, a path inside the bare clone that is never read from disk)
    slug: str = ""  # the `prd:` the location was found to hold
    _tmp: list = field(default_factory=list, repr=False, compare=False)

    def close(self) -> None:
        """Remove every temporary directory `load` made; a Model loaded from one keeps only what it already read."""
        while self._tmp:
            self._tmp.pop().cleanup()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @property
    def folder(self) -> str:
        return self.prd_dir.relative_to(self.repo).as_posix()

    def default_branch(self) -> str:
        """`origin/HEAD` (as the branch it names) when set, else main; a URL's clone follows the remote's HEAD."""
        r = _git(self.repo, "rev-parse", "--abbrev-ref", "-q", "--verify", "origin/HEAD")
        out = r.stdout.decode("utf-8", "replace").strip()
        if r.returncode == 0 and out and out != "origin/HEAD":
            return out
        if self.location.url:
            r = _git(self.repo, "symbolic-ref", "-q", "--short", "HEAD")
            out = r.stdout.decode("utf-8", "replace").strip()
            if r.returncode == 0 and out:
                return out
        return "main"

    def commit(self, ref: str) -> str:
        """The full hex commit `ref` names; NoRef (a Refused) when it names none."""
        r = _git(self.repo, "rev-parse", "-q", "--verify", "--end-of-options", f"{ref}^{{commit}}")
        out = r.stdout.decode("utf-8", "replace").strip()
        if r.returncode != 0 or not out:
            raise NoRef(f"{self.location.raw} has no ref {ref}")
        return out

    def resolve(self, ref: str | None) -> tuple[str, str]:
        """(the ref read, its commit): `ref`, or the default branch when None, whose absence names the way out."""
        at = ref or self.default_branch()
        try:
            return at, self.commit(at)
        except NoRef as e:
            if ref is None:
                raise NoRef(f"{e}; pass --ref <branch>") from None
            raise

    def is_ancestor(self, commit: str, ref: str) -> bool:
        return _git(self.repo, "merge-base", "--is-ancestor", commit, ref).returncode == 0

    def show(self, ref: str, rel: str) -> str | None:
        """A file's text at `ref` (path relative to the repository root), or None when absent."""
        r = _git(self.repo, "cat-file", "blob", f"{ref}:{rel}")
        return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None

    def load(self, ref: str | None) -> model.Prd:
        """The PRD at `ref` (copied out of git into a temporary directory), or the working tree for None (path locations only)."""
        if ref is None:
            if self.location.url:
                raise ValueError(f"{self.location.raw}: a URL location has no working tree")
            return model.load(self.prd_dir)
        commit = self.commit(ref)
        listing = _out(self.repo, "ls-tree", "--full-tree", "-r", "-z", commit, "--", self.folder,
                       why=f"{self.location.raw} is unreachable")
        blobs: list[tuple[bytes, str]] = []
        for entry in filter(None, listing.split(b"\0")):
            meta, _, path = entry.partition(b"\t")
            mode, kind, sha = meta.split()
            if kind == b"blob" and mode != b"120000":  # a symlink is not copied
                blobs.append((sha, path.decode("utf-8", "surrogateescape")))
        if not any(p == f"{self.folder}/prd.md" for _, p in blobs):
            raise Refused(f"{self.location.raw} holds no PRD at {self.folder} on {ref}")
        data = _out(self.repo, "cat-file", "--batch", input=b"".join(s + b"\n" for s, _ in blobs),
                    why=f"{self.location.raw} is unreachable")
        tmp = tempfile.TemporaryDirectory(prefix="prd-links-")
        self._tmp.append(tmp)
        root, pos = Path(tmp.name), 0
        for _, path in blobs:
            nl = data.index(b"\n", pos)
            size = int(data[pos:nl].split()[2])
            body = data[nl + 1:nl + 1 + size]
            pos = nl + 1 + size + 1
            dest = root / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
        return model.load(root / self.folder)


def _slug_of(text: str | None) -> str | None:
    """The `prd:` of a prd.md text ("" when it has none); None when there is no prd.md."""
    return None if text is None else frontmatter(text)[0].get("prd", "")


def _held(raw: str, found: list[str], expect: str | None) -> Refused:
    if not found:
        return Refused(f"{raw} holds no PRD")
    return Refused(f"{raw} holds PRD {', '.join(sorted(found))}, not {expect}" if expect else
                   f"{raw} holds PRDs {', '.join(sorted(found))}; a path location names a repository with one PRD")


def open_side(here_root: Path, loc: Location, expect: str | None = None) -> Side:
    """The other repository: a path resolved against `here_root` (read from disk), or a URL through the cache
    (read at its default branch). With `expect`, the PRD there must be `prd: <expect>`."""
    if loc.path is not None:
        repo = (Path(here_root) / loc.path).resolve()
        if not repo.is_dir():
            raise Unreachable(f"{loc.raw} is unreachable: no directory {repo}")
        prd_root = repo / "docs/prd"
        on_disk = {d: _slug_of((d / "prd.md").read_text(encoding="utf-8")) for d in sorted(prd_root.iterdir())
                   if (d / "prd.md").is_file()} if prd_root.is_dir() else {}
        if expect is not None and on_disk.get(prd_root / expect) == expect:
            return Side(loc, repo, prd_root / expect, expect)
        if expect is None and len(on_disk) == 1:
            (d, slug), = on_disk.items()
            return Side(loc, repo, d, slug)
        if expect is not None and prd_root / expect in on_disk:
            raise _held(loc.raw, [on_disk[prd_root / expect] or "(none)"], expect)
        raise _held(loc.raw, [s or "(none)" for s in on_disk.values()], expect)
    repo = _fetch(loc)
    side = Side(loc, repo, repo / loc.folder)
    slug = _slug_of(side.show(side.default_branch(), f"{loc.folder}/prd.md"))
    if slug is None:
        raise Refused(f"{loc.raw} holds no PRD")
    if expect is not None and slug != expect:
        raise _held(loc.raw, [slug or "(none)"], expect)
    side.slug = slug
    return side


# ---------------------------------------------------------------- links.md text

def _row(*cells: str) -> str:
    return "| " + " | ".join(cells) + " |"


def _heading(line: str) -> bool:
    return line.startswith("#") and line.lstrip("#").startswith(" ")


def _add_row(text: str, title: str, header: str, row: str) -> str:
    """`text` with `row` appended to the table under `## <title>`, adding the table or the section when absent."""
    lines = text.rstrip("\n").split("\n")
    sep = "|" + "---|" * len(split_cells(header))
    at = next((i for i, x in enumerate(lines) if x.strip() == f"## {title}"), None)
    if at is None:
        block = [f"## {title}", "", header, sep, row, ""]
        before = next((i for i, x in enumerate(lines) if x.strip() == "## Consumers"), None) if title == "Upstreams" else None
        if before is None:
            return "\n".join(lines + [""] + block).rstrip("\n") + "\n"
        return "\n".join(lines[:before] + block + lines[before:]).rstrip("\n") + "\n"
    end = next((i for i in range(at + 1, len(lines)) if _heading(lines[i])), len(lines))
    first = next((i for i in range(at + 1, end) if lines[i].lstrip().startswith("|")), None)
    if first is None:
        lines[at + 1:at + 1] = ["", header, sep, row]
    else:
        last = first
        while last + 1 < end and lines[last + 1].lstrip().startswith("|"):
            last += 1
        lines.insert(last + 1, row)
    return "\n".join(lines).rstrip("\n") + "\n"


def _set_lock(text: str, name: str, version: str, commit: str) -> str:
    """`text` with the Version and Commit cells of Upstreams row `name` replaced."""
    lines, section = text.split("\n"), ""
    for i, line in enumerate(lines):
        if _heading(line):
            section = line.strip()
        elif section == "## Upstreams" and line.lstrip().startswith("|"):
            cells = [c.strip() for c in split_cells(line)]
            if cells and cells[0].strip("`") == name:
                cells = (cells + [""] * 5)[:5]
                cells[2], cells[3] = version, commit
                lines[i] = _row(*cells)
                return "\n".join(lines)
    raise Refused(f"no Upstreams row '{name}'")


# ---------------------------------------------------------------- add and sync

def _here(prd: model.Prd) -> Path:
    return toplevel(prd.root)


def _my_url(here: Path, prd: model.Prd) -> str:
    r = _git(here, "remote", "get-url", "origin")
    url = r.stdout.decode("utf-8", "replace").strip() if r.returncode == 0 else ""
    return f"{url or '<git URL of this repository>'}#{prd.root.relative_to(here).as_posix()}"


def add(prd: model.Prd, location: str, needs: str = "") -> list[str]:
    """Write the Upstreams row here and the Consumers row there (or print it, for a URL location)."""
    cell = location.strip()
    loc = parse_location(cell if cell.startswith("`") else f"`{cell}`")
    needs = needs.strip()
    if needs and not _NEEDS.fullmatch(needs):
        raise BadArgument(f"--needs {needs!r}: must be verified or live in <env>")
    me = prd.frontmatter.get("prd", "")
    here = _here(prd)
    side = open_side(here, loc)
    other = side.slug
    if other == me or (loc.path is not None and side.prd_dir == prd.root):
        raise Refused("a PRD cannot link to itself")
    if prd.links and any(r.name == other for r in prd.links.upstreams):
        raise Refused(f"links.md already has an Upstreams row '{other}'")
    ours = prd.root / model.LINKS_FILE
    our_text = _add_row(ours.read_text(encoding="utf-8") if ours.is_file() else SKELETON, "Upstreams", UPSTREAM_HEADER,
                        _row(other, loc.raw, "", "", needs))
    report = [f"{model.LINKS_FILE}: added Upstreams row {other} {loc.raw}"]
    writes = [(ours, our_text)]
    if loc.path is not None:
        theirs = side.prd_dir / model.LINKS_FILE
        back = f"`{Path(os.path.relpath(here, side.repo)).as_posix()}`"
        shown = f"{loc.path.rstrip('/')}/{side.folder}/{model.LINKS_FILE}"
        their_links = model.load(side.prd_dir).links
        if their_links and any(r.name == me for r in their_links.consumers):
            report.append(f"{shown}: already has a Consumers row {me}")
        else:
            writes.append((theirs, _add_row(theirs.read_text(encoding="utf-8") if theirs.is_file() else SKELETON, "Consumers",
                                            CONSUMER_HEADER, _row(me, back))))
            report.append(f"{shown}: added Consumers row {me} {back}")
    else:
        report.append(f"{other} is not on disk: add this row to the Consumers table of its links.md "
                      f"({loc.url}#{loc.folder}): {_row(me, '`' + _my_url(here, prd) + '`')}")
    for path, text in writes:
        path.write_text(text, encoding="utf-8")
    return report


def _missing(up: model.Prd, kind: str, name: str, upstream: str, ref: str) -> str:
    if kind in ("event", "job") and "contracts/asyncapi.yaml" in up.yaml and name in event_names(up):
        return f"{kind}:{name}: asyncapi items cannot be cited across repositories"
    return f"{kind}:{name}: not in {upstream} at {ref}"


def _load_held(side: Side, commit: str, expect: str) -> model.Prd:
    """The PRD at `commit`, which must be `prd: <expect>`."""
    other = side.load(commit)
    held = other.frontmatter.get("prd", "")
    if held != expect:
        raise Refused(f"{side.location.raw} holds PRD {held or '(none)'}, not {expect}")
    return other


def sync(prd: model.Prd, upstream: str, ref: str | None = None) -> list[str]:
    """Copy every item this PRD cites from `upstream` at `ref` (default: its default branch) into the snapshot,
    remove snapshot files no longer needed, and write the lock. Refused, writing nothing, when an item is missing."""
    row = next((r for r in (prd.links.upstreams if prd.links else []) if r.name == upstream), None)
    if row is None:
        raise Refused(f"no Upstreams row '{upstream}'")
    try:
        loc = parse_location(row.location)
    except BadArgument as e:
        raise Refused(f"Upstreams row '{upstream}': {e}") from None
    with open_side(_here(prd), loc, expect=upstream) as side:
        at, commit = side.resolve(ref)
        up = _load_held(side, commit, upstream)
        version = up.frontmatter.get("version", "")
        if not _VERSION.fullmatch(version):
            raise Refused(f"{upstream} at {at} has no X.Y.Z version (found {version!r})")
        cited = set(citations.collect(prd).get(upstream, {}))
        contracts = snapshot.contracts_of(up)
        try:
            bodies = snapshot.extract(contracts, cited)
        except snapshot.Missing as e:
            raise Refused("; ".join(_missing(up, k, n, upstream, at) for k, n in e.items)) from None
    kinds = {fname: kind for kind, fname in contracts.types.items()}
    files = {name: snapshot.header(name, upstream, version, commit, kinds.get(name), contracts.dialect if name == "schema.sql" else None)
             + "\n" + body for name, body in bodies.items()}
    links_path = prd.root / model.LINKS_FILE
    links_text = _set_lock(links_path.read_text(encoding="utf-8"), upstream, version, commit)

    base = prd.root / model.UPSTREAM_DIR / upstream
    rel = f"{model.UPSTREAM_DIR}/{upstream}"
    old = sorted(p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file()
                 and not any(part.startswith(".") for part in p.relative_to(base).parts)) if base.is_dir() else []
    report = []
    for name, text in sorted(files.items()):
        dest = base / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
        report.append(f"wrote {rel}/{name}")
    for name in old:
        if name not in files:
            (base / name).unlink()
            report.append(f"removed {rel}/{name}")
    for d in sorted((p for p in base.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True) if base.is_dir() else []:
        if not any(d.iterdir()):
            d.rmdir()
    if base.is_dir() and not any(base.iterdir()):
        base.rmdir()
    links_path.write_text(links_text, encoding="utf-8")
    report.append(f"{model.LINKS_FILE}: locked {upstream} {version} at {commit} ({at})")
    if not cited:
        report.append(f"note: nothing in this PRD cites {upstream}/; the snapshot is empty")
    return report


# ---------------------------------------------------------------- check and impact

DRIFT = ("changed", "removed", "orphaned lock", "missing row")
_NEEDS_ENV = "needs env "  # `needs env <env> is not an environment of <upstream>`: drift, as a missing row is


@dataclass
class CheckLine:
    side: str  # upstream | consumer
    name: str  # the other PRD
    item: str | None  # `<kind>:<name>`, or None for a line about the link itself
    verdict: str  # same, changed, removed, newer than lock, orphaned lock, missing row, unreachable, or a needs-env line
    why: str = ""  # an unreachable side's reason

    def __str__(self) -> str:
        head = f"{self.side} {self.name}" + (f" {self.item}" if self.item else "")
        return f"{head}: {self.verdict}" + (f" ({self.why})" if self.why else "")


def is_drift(x: CheckLine) -> bool:
    return x.verdict in DRIFT or x.verdict.startswith(_NEEDS_ENV)


def check_exit(lines: list[CheckLine]) -> int:
    """1 on any drift; else 3 when a side was unreachable; else 0."""
    if any(is_drift(x) for x in lines):
        return 1
    return 3 if any(x.verdict == "unreachable" for x in lines) else 0


def open_change_sets(prd: model.Prd, repo_root: Path) -> list[tuple[str, set[str]]]:
    """(`<start-prd>/CS-nnn`, its member slugs) of each open record (Status not done or abandoned) whose rows name this
    PRD: under its own changes/, and under docs/prd/*/changes/ in each path Location of links.md (Where to enter's
    lookup), read from the working tree."""
    me = prd.frontmatter.get("prd", "")
    found: list[tuple[str, model.ChangeSet]] = [(c.id, c) for c in prd.change_sets.values()]
    seen = {prd.root.resolve()}
    for row in (prd.links.upstreams + prd.links.consumers) if prd.links else []:
        try:
            loc = parse_location(row.location)
        except ValueError:
            continue
        if loc.path is None:
            continue
        for folder in sorted((Path(repo_root) / loc.path / "docs/prd").glob("*/")):
            if folder.resolve() in seen or not (folder / model.CHANGES_DIR).is_dir():
                continue
            seen.add(folder.resolve())
            for p in sorted((folder / model.CHANGES_DIR).glob("CS-*.md")):
                if model._CS_FILE.fullmatch(p.name):
                    found.append((p.stem, model._change_set(f"{model.CHANGES_DIR}/{p.name}", p.read_text(encoding="utf-8"))))
    out = []
    for cid, cs in found:
        members = {r.prd for r in cs.rows}
        if cs.status in ("done", "abandoned") or me not in members:
            continue
        start = cs.started.rpartition(" in ")[2].strip() or me
        out.append((f"{start}/{cid}", members))
    return out


def let_through(prd: model.Prd, repo_root: Path, lines: list[CheckLine]) -> list[tuple[CheckLine, str | None]]:
    """R-13a, shared by the deploy pre-flight and `check --ci` (R-F2): each line with the open record
    (`<start-prd>/CS-nnn`) that lets it through, or None. A drift line is let through when an open record lists both
    this PRD and the line's other side as members; the records are read only when some line drifted."""
    sets = open_change_sets(prd, repo_root) if any(is_drift(x) for x in lines) else []
    return [(x, next((cid for cid, members in sets if x.name in members), None) if is_drift(x) else None) for x in lines]


def allowed(by: str, x: CheckLine) -> str:
    return f"drift allowed by {by}: {x}"


def _ver(v: str) -> tuple[int, ...] | None:
    return tuple(int(x) for x in v.split(".")) if _VERSION.fullmatch(v or "") else None


def _newer(live: str, lock: str) -> bool:
    a, b = _ver(live), _ver(lock)
    return a is not None and b is not None and a > b


def _snapshot_items(snap: snapshot.Contracts, cited) -> dict[str, tuple[str, str]]:
    """`<kind>:<name>` label -> (kind, name) of every item in a snapshot. events.md lists a name under event and
    job alike; it is labelled job only when cited as a job and never as an event."""
    out = {}
    for kind, names in snapshot.items(snap).items():
        if kind == "job":
            continue
        for name in names:
            label_kind = "job" if kind == "event" and ("job", name) in cited and ("event", name) not in cited else kind
            out[f"{label_kind}:{name}"] = (kind, name)
    return out


def _compare(snap: snapshot.Contracts, live: snapshot.Contracts, cited) -> list[tuple[str, str]]:
    """(label, same | changed | removed) for every snapshot item against the live contracts, sorted by label."""
    out = []
    for label, (kind, name) in sorted(_snapshot_items(snap, cited).items()):
        now = snapshot.item_text(live, kind, name)
        out.append((label, "removed" if now is None else "same" if now == snapshot.item_text(snap, kind, name) else "changed"))
    return out


def _open(prd: model.Prd, here: Path, row: model.LinkRow) -> Side:
    """The side a links.md row names; Unreachable for a malformed location, Refused for a link to itself."""
    if row.name == prd.frontmatter.get("prd", ""):
        raise Refused("a PRD cannot link to itself")
    try:
        loc = parse_location(row.location)
    except BadArgument as e:
        raise Unreachable(str(e)) from None
    side = open_side(here, loc, expect=row.name)
    if loc.path is not None and side.prd_dir == prd.root:
        side.close()
        raise Refused("a PRD cannot link to itself")
    return side


def _check_upstream(prd: model.Prd, here: Path, row: model.LinkRow, ref: str | None, cited) -> list[CheckLine]:
    def line(verdict: str, item: str | None = None, why: str = "") -> CheckLine:
        return CheckLine("upstream", row.name, item, verdict, why)

    me = prd.frontmatter.get("prd", "")
    out: list[CheckLine] = []
    try:
        with _open(prd, here, row) as side:
            at, commit = side.resolve(ref)
            up = _load_held(side, commit, row.name)
            live = snapshot.contracts_of(up)
            orphaned = False
            if row.commit:
                base = side.default_branch()
                try:
                    side.commit(base)
                except NoRef:
                    base = at  # no default branch to judge by: the ref the user named stands in for it
                orphaned = not side.is_ancestor(row.commit, base)
    except (Unreachable, NoRef) as e:
        return [line("unreachable", why=str(e))]
    needs = row.needs.strip()
    if needs.startswith("live in "):
        env = needs[len("live in "):].strip()
        if env not in up.operations.environments:
            out.append(line(f"{_NEEDS_ENV}{env} is not an environment of {row.name}"))
    if not (up.links and any(r.name == me for r in up.links.consumers)):
        out.append(line("missing row"))
    if _newer(up.frontmatter.get("version", ""), row.version):
        out.append(line("newer than lock"))
    if orphaned:
        out.append(line("orphaned lock"))
    snaps = prd.snapshots.get(row.name)
    if snaps:
        out += [line(v, item) for item, v in _compare(snapshot.contracts_of_snapshot(snaps), live, cited)]
    return out


def _check_consumer(prd: model.Prd, here: Path, row: model.LinkRow, mine: snapshot.Contracts) -> list[CheckLine]:
    def line(verdict: str, item: str | None = None, why: str = "") -> CheckLine:
        return CheckLine("consumer", row.name, item, verdict, why)

    me = prd.frontmatter.get("prd", "")
    try:
        with _open(prd, here, row) as side:
            _, commit = side.resolve(None)  # a consumer is read at its default branch; --ref is the upstream side's
            cons = _load_held(side, commit, row.name)
            cited = citations.collect(cons).get(me, {})
    except (Unreachable, NoRef) as e:
        return [line("unreachable", why=str(e))]
    out: list[CheckLine] = []
    theirs = next((r for r in cons.links.upstreams if r.name == me), None) if cons.links else None
    if theirs is None:
        out.append(line("missing row"))
    elif _newer(prd.frontmatter.get("version", ""), theirs.version):
        out.append(line("newer than lock"))
    snaps = cons.snapshots.get(me)
    if snaps:
        out += [line(v, item) for item, v in _compare(snapshot.contracts_of_snapshot(snaps), mine, cited)]
    return out


def check(prd: model.Prd, ref: str | None = None) -> list[CheckLine]:
    """Every link both ways: each Upstream's snapshot against the upstream at `ref` (default: its default branch),
    the lock, Needs and the matching Consumers row; each Consumer's snapshot of this PRD (read at the consumer's
    default branch) against this working tree, and its matching Upstreams row."""
    if prd.links is None:
        return []
    here = _here(prd)
    cited = citations.collect(prd)
    out: list[CheckLine] = []
    for row in prd.links.upstreams:
        out += _check_upstream(prd, here, row, ref, cited.get(row.name, {}))
    mine = snapshot.contracts_of(prd) if prd.links.consumers else None
    for row in prd.links.consumers:
        out += _check_consumer(prd, here, row, mine)
    return out


def _all_items(c: snapshot.Contracts) -> set[tuple[str, str]]:
    return {(k, n) for k, names in snapshot.items(c).items() if k != "job" for n in names}


def impact(prd: model.Prd, base: str = "HEAD") -> tuple[list[str], dict[str, list[str]], list[str]]:
    """(the contract items this working tree changes against `base`, consumer -> the changed items it cites,
    the consumers that were unreachable). A consumer's citations are its committed snapshot of this PRD and the
    references its PRD makes, both at its default branch."""
    me = prd.frontmatter.get("prd", "")
    here = _here(prd).resolve()
    mine = snapshot.contracts_of(prd)
    with Side(Location("this repository", ".", None, None), here, prd.root, me) as own:
        _, commit = own.resolve(base)
        try:
            old = snapshot.contracts_of(own.load(commit))
        except NoRef:
            raise
        except Refused:  # no PRD at `base`: every item is new
            old = snapshot.Contracts({}, {}, None)
    changed = {(k, n) for k, n in _all_items(old) | _all_items(mine)
               if snapshot.item_text(old, k, n) != snapshot.item_text(mine, k, n)}
    consumers: dict[str, list[str]] = {}
    unreachable: list[str] = []
    for row in prd.links.consumers if prd.links else []:
        try:
            with _open(prd, here, row) as side:
                _, c = side.resolve(None)
                cons = _load_held(side, c, row.name)
                cited = set(citations.collect(cons).get(me, {}))
        except (Unreachable, NoRef):
            unreachable.append(row.name)
            continue
        snaps = cons.snapshots.get(me)
        if snaps:
            cited |= {tuple(label.split(":", 1)) for label in _snapshot_items(snapshot.contracts_of_snapshot(snaps), cited)}
        hit = sorted({f"{k}:{n}" for k, n in cited if ("event" if k == "job" else k, n) in changed})
        if hit:
            consumers[row.name] = hit
    return sorted(f"{k}:{n}" for k, n in changed), consumers, unreachable
