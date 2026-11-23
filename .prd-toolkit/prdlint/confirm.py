"""The items an adoption area asks its owner to confirm: requirements, bugs, questions and markers."""
import hashlib
import json
import os
import re
import secrets
import subprocess
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # no cross-process lock off POSIX; the in-process lock and the atomic replace remain
    fcntl = None

from . import formserver
from .model import _MARKER, Prd, ReqBlock, _field_lines, repo_root

SUMMARY_MAX = 400
CONTEXT_LINES = 10
_CITE = re.compile(r"([^\s,;`()]+):(\d+)(?:\s*@([0-9A-Za-z]+))?")
_BULLET = re.compile(r"^[-*]\s+(.*)$")  # a top-level bullet; an indented one continues the bullet above
_QID = re.compile(r"^(Q-\d+)\b\s*(.*)$")
_ID = re.compile(r"\b(?:UJ|FR|NFR)-\d+\b")


class Refused(Exception):
    """Something the owner must fix before a form can be served."""


class StillOpen(Refused):
    """`mark_done` found items with no answer, or an answer given to other text."""

    def __init__(self, ids: list[str]):
        super().__init__(f"{len(ids)} item(s) still open: {', '.join(ids)}")
        self.ids = ids


@dataclass
class Item:
    id: str
    kind: str  # requirement | bug | question | marker
    title: str
    text: str  # the item as served; its SHA-256 is the fingerprint
    acs: list[tuple[str, str]] = field(default_factory=list)
    excerpts: list[str] = field(default_factory=list)
    fingerprint: str = ""
    where: str = ""
    related: list[str] = field(default_factory=list)  # a requirement's open E-nnn entries that touch it
    confirmed: str | None = None  # a bug's `Confirmed:` reply in errors.md: the item counts as answered


def _fp(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _excerpt(root: Path, path: str, line: int, commit: str | None, cache: dict) -> str:
    ref = commit or "HEAD"
    key = (ref, path)
    if key not in cache:
        try:
            out = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=root, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=30, check=True).stdout
            cache[key] = out.split("\n")
            if cache[key][-1] == "":
                cache[key].pop()
        except (OSError, subprocess.SubprocessError):
            cache[key] = None
    lines = cache[key]
    if lines is None:
        return f"(code not available at {ref})"
    lo, hi = max(1, line - CONTEXT_LINES), min(len(lines), line + CONTEXT_LINES)
    if lo > hi:
        return f"(code not available at {ref})"
    return "\n".join(f"{n:>4} | {lines[n - 1]}" for n in range(lo, hi + 1))


def _in_repo(root: Path, path: str, commit: str | None, cache: dict) -> bool:
    """An extensionless name (`Makefile`) is a file only when git has it at that commit."""
    key = ("exists", commit or "HEAD", path)
    if key not in cache:
        try:
            cache[key] = subprocess.run(["git", "cat-file", "-e", f"{commit or 'HEAD'}:{path}"], cwd=root,
                                        capture_output=True, timeout=30).returncode == 0
        except (OSError, subprocess.SubprocessError):
            cache[key] = False
    return cache[key]


def _excerpts(root: Path, text: str, cache: dict) -> list[tuple[str, int, str | None, str]]:
    out = []
    for p, n, sha in _CITE.findall(text):
        # a path, not a time or a host:port
        if "/" in p or re.search(r"\.\w+$", p) or _in_repo(root, p, sha or None, cache):
            out.append((p, int(n), sha or None, _excerpt(root, p, int(n), sha or None, cache)))
    return out


def _requirement(root: Path, b: ReqBlock, cache: dict) -> Item:
    served = "\n".join([f"### {b.id} {b.title}"] + [t for _, t in b.lines])
    cites = _excerpts(root, b.source or "", cache)
    where = f"{cites[0][0]}:{cites[0][1]}" if cites else b.file
    return Item(b.id, "requirement", b.title, served, [(a.id, a.text) for a in b.acs if not a.removed],
                [c[3] for c in cites], _fp(served), where)


def _name_re(name: str) -> re.Pattern:
    return re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])")


def _bugs(prd: Prd, root: Path, area: str, ids: set[str], cache: dict) -> list[Item]:
    lines = prd.docs.get("errors.md", "").split("\n")
    names_area = _name_re(area)
    out = []
    for e in prd.errors_ledger.values():
        if not e.open or not (any(t in ids for t, _ in e.touches) or names_area.search(e.detected)):
            continue
        served = "\n".join(lines[e.line - 1 : e.end]).rstrip()
        cites = _excerpts(root, e.detected, cache)
        out.append(Item(e.id, "bug", e.title, served, [], [c[3] for c in cites], _fp(served), "errors.md",
                        confirmed=e.confirmed[1] if e.state == "confirmed" and e.confirmed else None))
    return out


def _questions(prd: Prd, ids: set[str]) -> list[Item]:
    sec = next((s for s in prd.sections if s.number == 13), None)
    bullets: list[list[str]] = []
    for _, text in sec.body if sec else []:
        if _BULLET.match(text):
            bullets.append([text.rstrip()])
        elif bullets and text.startswith(" ") and text.strip():
            bullets[-1].append(text.rstrip())
    out = []
    for pos, b in enumerate(bullets, 1):
        served = "\n".join(b)
        if not set(_ID.findall(served)) & ids:
            continue
        head = _BULLET.match(b[0]).group(1).strip()
        qm = _QID.match(head)
        out.append(Item(qm.group(1) if qm else f"Q-{pos:02d}", "question", (qm.group(2) if qm else head)[:100],
                        served, [], [], _fp(served), "prd.md §13"))
    return out


Hit = tuple[list[str], int, str, int, int]  # (full key path, index of the named key, marker, line, nth in its string)


def _walk(node: Any, path: list[str], start: int | None, named: set[str], hits: list[Hit], line: int) -> None:
    """Collect markers under a key the area names; `start` is where that key sits in `path`."""
    if isinstance(node, dict):
        kl = getattr(node, "key_lines", {})
        for k, v in node.items():
            st = start if start is not None else (len(path) if str(k) in named else None)
            _walk(v, path + [str(k)], st, named, hits, kl.get(k, line))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _walk(v, path + [str(i)], start, named, hits, line)
    elif isinstance(node, str) and start is not None:
        for n, m in enumerate(_MARKER.finditer(node)):
            hits.append((path, start, m.group(0), line, n))


def _bare_name(chunk: str) -> str | None:
    """The key a word outside backticks names, or None. Only an identifier with an underscore (NOTES_LIMIT)
    or in camelCase (maxSize) names one: a dotted or kind:name word names its last part, and a path part,
    an ID prefix (FR-001), an all-caps word (UNIQUE, POST) or a version (v2) names nothing. Quotes and a
    trailing colon or full stop are dropped, and the <kind>:<prd>/<name> form names <name>."""
    chunk = chunk.strip("'\"").rstrip(":.")
    if re.fullmatch(r"[a-z]+:[a-z][a-z0-9-]*/[^/\s]+", chunk):
        chunk = chunk.rsplit("/", 1)[1]
    elif "/" in chunk:
        return None
    name = re.split(r"[:.]", chunk.strip("."))[-1]
    if re.fullmatch(r"[A-Za-z_]\w*", name) and re.search(r"[A-Za-z]", name) and re.search(r"_|[a-z][A-Z]", name):
        return name
    return None


def _named(prd: Prd, area: str, blocks: list[ReqBlock]) -> set[str]:
    """Contract keys the area names: backticked spans and, outside backticks, underscore or camelCase
    identifiers on its Traces lines (see _bare_name), and its test cases' targets. Prose names nothing."""
    words: set[str] = set()
    for b in blocks:
        for _, text in _field_lines(b.lines, "Traces"):
            for span in re.findall(r"`([^`]+)`", text):
                for tok in re.findall(r"[A-Za-z_][\w.-]*", span):
                    words.add(tok.strip(".").rsplit(".", 1)[-1])  # `settings.KEY` names KEY
            for chunk in re.split(r"[\s;,()]+", re.sub(r"`[^`]*`", " ", text)):
                if name := _bare_name(chunk):
                    words.add(name)
    for tc in prd.test_cases:
        target = tc.data.get("target") if isinstance(tc.data, dict) else None
        if tc.file == f"test-cases/{area}.yaml" and isinstance(target, str):
            words |= set(re.split(r"[:/\s]+", target.strip()))
            words.add(target.strip().rsplit(".", 1)[-1])
    return {w for w in words if w}


def _markers(prd: Prd, area: str, blocks: list[ReqBlock]) -> list[Item]:
    named = _named(prd, area, blocks)
    found: list[dict] = []
    for rel, data in prd.yaml.items():
        hits: list[Hit] = []
        _walk(data, [], None, named, hits, 0)
        src = (prd.root / rel).read_text(encoding="utf-8").split("\n")
        name = rel[len("contracts/"):] if rel.startswith("contracts/") else rel
        for path, start, marker, line, nth in hits:
            text = src[line - 1].strip() if 0 < line <= len(src) and marker in src[line - 1] else marker
            found.append({"rel": rel, "name": name, "path": path, "start": start, "marker": marker, "nth": nth,
                          "text": text if nth == 0 else f"{text}\n{marker}"})

    def ident(f: dict) -> str:
        return f"{f['name']}:{'.'.join(f['path'][f['start']:])}" + (f"#{f['nth'] + 1}" if f["nth"] else "")

    while True:  # extend colliding IDs upward through their ancestor keys until unique
        groups: dict[str, list[dict]] = {}
        for f in found:
            groups.setdefault(ident(f), []).append(f)
        grew = False
        for g in groups.values():
            if len(g) > 1:
                for f in g:
                    if f["start"] > 0:
                        f["start"] -= 1
                        grew = True
        if not grew:
            break
    out: list[Item] = []
    seen: dict[str, int] = {}
    for f in found:  # a collision that cannot be extended still keeps every marker
        iid = ident(f)
        seen[iid] = seen.get(iid, 0) + 1
        if seen[iid] > 1:
            iid += f"~{seen[iid]}"
        key = ".".join(f["path"][f["start"]:])
        out.append(Item(iid, "marker", key, f["text"], [], [], _fp(f["text"]), f"{f['rel']} {key}"))
    return out


def build_items(prd: Prd, area: str) -> list[Item]:
    if not any(r.area == area for r in prd.adoption or []):
        raise Refused(f"area {area} is not in adoption.md")
    root = repo_root(prd.root)
    blocks = [b for b in prd.blocks if b.file == f"features/{area}.md"]
    ids = {b.id for b in blocks}
    cache: dict = {}
    items = [_requirement(root, b, cache) for b in blocks if b.status == "as-built"]
    for i in items:
        i.related = [e.id for e in prd.errors_ledger.values() if e.open and any(t == i.id for t, _ in e.touches)]
    items += _bugs(prd, root, area, ids, cache)
    items += _questions(prd, ids)
    items += _markers(prd, area, blocks)
    if not items:
        raise Refused(f"area {area} has no item to confirm")
    seen: set[str] = set()
    for i in items:  # answers apply by ID, so two items under one ID could never both be answered
        if i.id in seen:
            raise Refused(f"item ID {i.id} appears twice in {i.where}")
        seen.add(i.id)
    return items


def check_summaries(data: Any, items: list[Item], area: str, source: str = "summaries") -> dict[str, str]:
    """The 0.7.1 summary rules: each summary names its item, and is at most SUMMARY_MAX characters."""
    if not isinstance(data, dict):
        raise Refused(f"{source} must be a JSON object mapping item ID to text")
    known = {i.id for i in items}
    for key, text in data.items():
        if key not in known:
            raise Refused(f"summary for {key} names no item of {area}")
        if not isinstance(text, str):
            raise Refused(f"summary for {key} must be text")
        if not _name_re(key).search(text):
            raise Refused(f"summary for {key} does not mention {key}")
        if len(text) > SUMMARY_MAX:
            raise Refused(f"summary for {key} is over {SUMMARY_MAX} characters")
    return dict(data)


def load_summaries(path: Path, items: list[Item], area: str) -> dict[str, str]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise Refused(f"cannot read summaries {path}: {e}") from e
    return check_summaries(data, items, area, f"summaries {path}")


# --- the answers file and the local server -------------------------------------------------------------------

REQUIRES_TEXT = {"correct", "bug", "ask", "answer"}  # `correct` is also satisfied by a non-empty `acs`
ALLOWED = {"requirement": {"confirm", "correct", "bug", "ask"}, "bug": {"bug", "intended", "ask"},
           "question": {"intended", "fix", "answer"}, "marker": {"answer"}}
MAX_BODY = formserver.MAX_BODY  # re-exported: the server parts live in formserver
CSP = formserver.CSP
EXCLUDE_LINE = "/.prd-confirm-*.json"


def answers_path(repo_root: Path, area: str) -> Path:
    return Path(repo_root) / f".prd-confirm-{area}.json"


def load_answers(path: Path) -> dict:
    """The saved file; {} when it does not exist. A file that exists but is not an answers object is refused,
    so an accepted answer is never silently thrown away."""
    path = Path(path)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as e:
        raise Refused(f"answers file {path} cannot be read: {e}") from e
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise Refused(f"answers file {path} is not valid JSON; move it aside to start over")
    return data


def save_answers(path: Path, data: dict) -> None:
    """Rewrite the whole file through a temporary file in the same folder, then os.replace."""
    formserver.write_json_atomic(path, data)


def open_ids(items: list[Item], answers: dict) -> list[str]:
    """Items with no answer, or whose answer was given to a different text (its fingerprint differs).
    A bug whose errors.md entry holds `Confirmed:` is answered, with or without an answers file."""
    saved = answers.get("answers", {}) if isinstance(answers, dict) else {}
    return [i.id for i in items if i.confirmed is None
            and (not isinstance(saved.get(i.id), dict) or saved[i.id].get("fingerprint") != i.fingerprint)]


def ensure_excluded(repo_root: Path) -> None:
    """Add `/.prd-confirm-*.json` to the common git dir's info/exclude, once."""
    formserver.ensure_excluded(repo_root, EXCLUDE_LINE)


_WRITE_LOCK = threading.Lock()  # one writer at a time in this process; the directory flock covers other processes


@contextmanager
def _locked(root: Path):
    with _WRITE_LOCK:
        dirfd = None
        if fcntl is not None:
            try:
                dirfd = os.open(root, os.O_RDONLY)
                try:
                    fcntl.flock(dirfd, fcntl.LOCK_EX)
                except OSError:
                    os.close(dirfd)
                    dirfd = None
            except OSError:
                dirfd = None
        try:
            yield
        finally:
            if dirfd is not None:
                os.close(dirfd)


def _head(root: Path) -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True,
                          encoding="utf-8", timeout=30).stdout.strip()


def _mutate(prd: Prd, area: str, root: Path, apply, head: str | None = None) -> dict:
    """Under the locks: re-read the file, let `apply(data)` change the keys it owns, save. Every other key stays."""
    root = Path(root)
    path = answers_path(root, area)
    with _locked(root):
        data = load_answers(path)
        answers = data.get("answers")
        data.update({"prd": prd.frontmatter.get("prd", ""), "area": area, "commit": head or _head(root)})
        data["answers"] = answers if isinstance(answers, dict) else {}
        apply(data)
        save_answers(path, data)
        return data


def validate_answer(item: Item, decision: Any, text: Any, acs: Any) -> tuple[str, dict[str, str]]:
    """The checks the form's save makes; (text, acs) cleaned, or Refused."""
    if not isinstance(decision, str) or decision not in {d for ds in ALLOWED.values() for d in ds}:
        raise Refused(f"unknown decision {decision!r}")
    if decision not in ALLOWED[item.kind]:
        raise Refused(f"decision {decision} is not allowed for a {item.kind}")
    if item.confirmed is not None:
        raise Refused(f"{item.id} is confirmed in errors.md; change it through /prd-toolkit:prd-error")
    if text is not None and not isinstance(text, str):
        raise Refused("text must be a string")
    text = (text or "").strip()
    if acs is not None and not (isinstance(acs, dict) and all(isinstance(v, str) for v in acs.values())):
        raise Refused("acs must map an AC ID to text")
    if acs is not None and decision != "correct":
        raise Refused("acs is allowed only with correct")
    known = {a for a, _ in item.acs}
    for k in acs or {}:
        if k not in known:
            raise Refused(f"{k} is not an AC of {item.id}")
    acs = {k: v.strip() for k, v in (acs or {}).items() if v.strip()}
    if decision == "correct":
        if not text and not acs:
            raise Refused("correct needs text or an edited AC")
    elif decision == "fix" and not text:
        raise Refused("a fix needs its words: what should it do instead?")
    elif decision in REQUIRES_TEXT and not text:
        raise Refused(f"{decision} needs text")
    return text, acs


def _entry(item: Item, decision: str, text: str, acs: dict[str, str], reply: str | None = None) -> dict[str, Any]:
    entry: dict[str, Any] = {"decision": decision}
    if text:
        entry["text"] = text
    if acs:
        entry["acs"] = acs
    if reply is not None:
        entry["reply"] = reply  # verbatim: never stripped or rewritten
    entry["fingerprint"] = item.fingerprint
    entry["where"] = item.where  # with `served`, how the session finds the item again
    entry["served"] = item.text
    entry["at"] = datetime.now(timezone.utc).isoformat()
    return entry


def _store(prd: Prd, area: str, root: Path, item: Item, entry: dict, head: str | None = None) -> dict:
    def apply(data: dict) -> None:
        data["answers"][item.id] = entry
        data.pop("done", None)  # a reopened area is pending again
    return _mutate(prd, area, root, apply, head)


def record_answer(prd: Prd, area: str, item_id: str, decision: str, reply: str, correction: str | None,
                  repo_root: Path) -> dict:
    """Answer one item from outside the form. `reply` is kept verbatim; `text` is the correction, else the reply."""
    if not isinstance(reply, str) or not reply.strip():
        raise Refused("the reply is empty")
    if correction is not None and not correction.strip():
        raise Refused("--correction is empty")
    by_id = {i.id: i for i in build_items(prd, area)}
    if item_id not in by_id:
        raise Refused(f"unknown item {item_id!r}")
    item = by_id[item_id]
    text, acs = validate_answer(item, decision, correction if correction is not None else reply, None)
    return _store(prd, area, repo_root, item, _entry(item, decision, text, acs, reply))


def mark_done(prd: Prd, area: str, items: list[Item], repo_root: Path) -> dict:
    """Write `"done": true`; Refused while an item has no answer or its answer was given to other text."""
    root = Path(repo_root)
    path = answers_path(root, area)
    with _locked(root):
        data = load_answers(path)
        pending = open_ids(items, data)
        if pending:  # refuses before anything is written
            raise StillOpen(pending)
        answers = data.get("answers")
        data.update({"prd": prd.frontmatter.get("prd", ""), "area": area, "answers": answers if isinstance(answers, dict) else {}})
        data.setdefault("commit", _head(root))
        data["done"] = True
        save_answers(path, data)
        return data


def open_file(prd: Prd, area: str, items: list[Item], summaries: dict, repo_root: Path) -> Path:
    """Start the answers file: summaries and no answers. Never replaces a file that exists."""
    root = Path(repo_root)
    if not items:
        raise Refused(f"area {area} has no item to confirm")
    summaries = check_summaries(summaries, items, area)
    path = answers_path(root, area)
    ensure_excluded(root)
    with _locked(root):
        if path.exists():
            raise Refused(f"{path.name} exists; answer, run status, or move it aside")
        save_answers(path, {"prd": prd.frontmatter.get("prd", ""), "area": area, "commit": _head(root),
                            "summaries": summaries, "answers": {}})
    return path


class BadRequest(Refused):
    """A request the page sent wrong (an unknown item, a decision the item does not take): answered 400."""


def saved_summaries(items: list[Item], area: str, repo_root: Path) -> dict[str, str]:
    """The summaries `open` wrote into the answers file, checked by the 0.7.1 rules; {} when it holds none."""
    path = answers_path(repo_root, area)
    saved = load_answers(path).get("summaries")
    if not saved:
        return {}
    try:
        return check_summaries(saved, items, area, f"summaries in {path.name}")
    except Refused as e:
        raise Refused(f"the summaries saved in the answers file {path.name} are not valid: {e}; fix or remove them") from e


class AdoptionRoutes:
    """The item panel's requests for one area, against that area's answers file in `repo_root` (its worktree).

    The 0.7.1 form and the decision inbox both serve these. `item_list`, `summaries` and `head` default to the
    area's items now, the summaries saved in the answers file, and HEAD. Every method raises Refused: BadRequest
    for a request sent wrong (400), StillOpen from `done` (409), plain Refused for an answers file that cannot
    be read (500)."""

    def __init__(self, prd: Prd, area: str, repo_root: Path, item_list: list[Item] | None = None,
                 summaries: dict | None = None, head: str | None = None):
        self.prd, self.area, self.root = prd, area, Path(repo_root)
        self.item_list = build_items(prd, area) if item_list is None else item_list
        self.summaries = saved_summaries(self.item_list, area, self.root) if summaries is None else summaries
        self.by_id = {i.id: i for i in self.item_list}
        self.path = answers_path(self.root, area)
        self.head = head or _head(self.root)
        load_answers(self.path)  # a corrupt file refuses before anything is served

    def _item(self, body: dict) -> Item:
        iid = body.get("id")
        if not isinstance(iid, str) or iid not in self.by_id:
            raise BadRequest(f"unknown item {iid!r}")
        return self.by_id[iid]

    def items(self) -> dict:
        with _WRITE_LOCK:
            data = load_answers(self.path)
        saved = data.get("answers", {}) if isinstance(data.get("answers"), dict) else {}
        shown = [{**asdict(i), "summary": self.summaries.get(i.id)} for i in self.item_list]
        changed = [i.id for i in self.item_list if isinstance(saved.get(i.id), dict)
                   and saved[i.id].get("fingerprint") != i.fingerprint]
        return {"area": self.area, "items": shown, "answers": saved, "open": open_ids(self.item_list, data),
                "changed": changed}

    def answer(self, body: dict) -> dict:
        item = self._item(body)
        try:
            text, acs = validate_answer(item, body.get("decision"), body.get("text"), body.get("acs"))
        except Refused as e:
            raise BadRequest(str(e)) from e
        data = _store(self.prd, self.area, self.root, item, _entry(item, body["decision"], text, acs), self.head)
        return {"open": open_ids(self.item_list, data)}

    def undo(self, body: dict) -> dict:
        iid = self._item(body).id

        def apply(data: dict) -> None:
            data["answers"].pop(iid, None)
            data.pop("done", None)
        return {"open": open_ids(self.item_list, _mutate(self.prd, self.area, self.root, apply, self.head))}

    def done(self) -> dict:
        """Write `done` through `mark_done`, as `prd_confirm.py done` does; StillOpen while an item is open or changed."""
        mark_done(self.prd, self.area, self.item_list, self.root)
        return {"open": []}


def refused_status(e: Refused) -> int:
    """The HTTP status of an AdoptionRoutes refusal."""
    return 409 if isinstance(e, StillOpen) else 400 if isinstance(e, BadRequest) else 500


def refused_body(e: Refused) -> dict:
    return {"open": e.ids} if isinstance(e, StillOpen) else {"error": str(e)}


class _State:
    """The 0.7.1 form's run: its page, its end, and the area's AdoptionRoutes."""

    def __init__(self, prd: Prd, area: str, items: list[Item], summaries: dict, page: str):
        self.prd, self.area, self.items, self.summaries, self.page = prd, area, items, summaries, page
        self.server: formserver.Server | None = None
        self.root = repo_root(prd.root)
        self._end: str | None = None
        self.routes = AdoptionRoutes(prd, area, self.root, items, summaries)

    @property
    def end(self) -> str | None:
        return self.server.end if self.server is not None else self._end

    @end.setter
    def end(self, value: str | None) -> None:
        self._end = value
        if self.server is not None:
            self.server.end = value

    def answer(self, body: dict) -> dict:
        return self.routes.answer(body)

    def undo(self, body: dict) -> dict:
        return self.routes.undo(body)

    def finish(self) -> list[str]:
        """The open IDs; when there are none, write `done` and end the run."""
        try:
            self.routes.done()
        except StillOpen as e:  # the check and the write share one lock, so this is the answer, not a race
            return e.ids
        self.end = "done"  # reported only after `done` is on disk
        return []

    def listing(self) -> dict:
        return self.routes.items()


def _handler(state: _State) -> type[formserver.Handler]:
    class Handler(formserver.Handler):
        def route(self, method: str, route: str, query: dict) -> None:
            try:
                self._route(method, route)
            except Refused as e:
                self.send_json(refused_status(e), refused_body(e))

        def _route(self, method: str, route: str) -> None:
            if method == "GET" and route == "/":
                self.send_page(state.page)
            elif method == "GET" and route == "/items":
                self.send_json(200, state.listing())
            elif method == "POST" and route in ("/answer", "/undo"):
                body = self.body_json()
                self.send_json(200, state.answer(body) if route == "/answer" else state.undo(body))
            elif method == "POST" and route == "/done":
                self.body_json()
                pending = state.finish()
                if pending:
                    self.send_json(409, {"open": pending})
                else:
                    self.send_json(200, {"open": []})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                raise formserver.Bad(404, "no such request")

    return Handler


def make_server(prd: Prd, area: str, items: list[Item], summaries: dict, page: str, port: int = 0,
                idle_minutes: float = 120, request_timeout: float = 30) -> tuple[formserver.Server, str]:
    """A server bound to 127.0.0.1 only, and its token. Raises OSError when `port` is in use, and Refused
    when the answers file exists but is not valid."""
    state = _State(prd, area, items, summaries, page)
    server, token = formserver.make_server(_handler(state), port, idle_minutes, state,
                                           token=secrets.token_hex(32), request_timeout=request_timeout)  # 64 hex, as in 0.7.1
    state.server = server
    return server, token


def run(server: formserver.Server) -> int:
    """Serve until Done (0), Ctrl-C or the idle timeout (3)."""
    return formserver.run(server)


def page_path() -> Path:
    """The form page: the plugin's template, or the copy vendored beside the scripts."""
    from . import hooks
    return hooks.PLUGIN_ROOT / "templates" / hooks.CONFIRM_PAGE if hooks.is_plugin() else hooks.SCRIPTS / hooks.CONFIRM_PAGE
