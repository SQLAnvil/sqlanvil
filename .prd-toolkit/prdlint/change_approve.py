"""prd_change.py approve (0.8.1): every check first, then the §14 record, the status and the approval commit."""
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import model
from .markdown import tables

SCRIPTS = Path(__file__).resolve().parent.parent
REVIEW_FILE = ".prd-review.json"
PENDING = "; pending"
NO_REFS = "Refs: none (no behaviour change)"


@dataclass
class Approved:
    commit: str


def _fail(message: str):
    from .change import ChangeError

    raise ChangeError(message)


def _one_line(text: str) -> bool:
    return bool(text.strip()) and "\n" not in text and "|" not in text


def _verdict(prd_root: Path) -> dict:
    path = prd_root / REVIEW_FILE
    if not path.is_file():
        _fail(f"there is no {REVIEW_FILE}; run the review first")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        _fail(f"{REVIEW_FILE} is not valid JSON")
    if not isinstance(data, dict) or data.get("ready") is not True:
        blockers = data.get("blockers") if isinstance(data, dict) else None
        _fail("the review is not ready" + (": " + "; ".join(str(b) for b in blockers) if blockers else ""))
    return data


def _lint(prd_root: Path) -> None:
    run = subprocess.run([sys.executable, str(SCRIPTS / "prd_lint.py"), str(prd_root)], capture_output=True, text=True, encoding="utf-8")
    if run.returncode != 0:
        _fail(f"lint exits {run.returncode}; fix it first")


def _log_rows(prd_root: Path):
    from .change import _table_of

    table = _table_of((prd_root / "prd.md").read_text(encoding="utf-8"), 14)
    return table.rows if table else []


def _non_unit(prd_root: Path, last) -> list[str]:
    """The T-ids in the last §14 row's IDs cell whose test case is not `unit`; a T-id with no case was removed and is skipped."""
    from .change import _REQ_ID

    levels = {tc.id: str(tc.data.get("level", "")) for tc in model.load(prd_root).test_cases}
    cell = last.cells[3] if len(last.cells) > 3 else ""
    tids = [m.group(0) for m in _REQ_ID.finditer(cell) if m.group(0).startswith("T-")]
    return [t for t in tids if t in levels and levels[t] != "unit"]


def _checked(repo_root: Path, prd_root: Path, reply: str, dry_run: str):
    """Run every check, write nothing; return the last §14 row."""
    from . import change

    if not reply.strip():
        _fail("the owner's reply is empty")
    if dry_run.strip() in ("", "pending"):
        _fail('the dry-run record is pending; give the record or "no dry run (<why>)"')
    if not _one_line(dry_run):
        _fail("the dry-run record must be one non-empty line without |")
    data = _verdict(prd_root)
    if data.get("digest") != change.digest(prd_root):
        _fail("the PRD changed after its review; review it again")
    _lint(prd_root)
    rows = _log_rows(prd_root)
    last = rows[-1] if rows else None
    risky = _non_unit(prd_root, last) if last is not None else []
    if risky and dry_run.strip().startswith("no dry run"):
        _fail(f"the change adds or revises a non-unit test ({', '.join(risky)}) and has no dry-run record")
    if not any(r.cells and r.cells[0].split(".")[0].isdigit() and int(r.cells[0].split(".")[0]) >= 1 for r in rows):
        _fail("a first approval is authoring's, not a change's")
    if last is None or len(last.cells) < 3 or not last.cells[2].endswith(PENDING):
        _fail("the last §14 row is not recorded and pending; run record first")
    if _claude_dirty(repo_root) and not _only_the_block(repo_root, prd_root):
        _fail("CLAUDE.md has uncommitted changes; commit or set them aside first")
    return last


def _claude_dirty(repo_root: Path) -> bool:
    return not _ignored(repo_root, "CLAUDE.md") and bool(_git(repo_root, "status", "--porcelain", "--", "CLAUDE.md").stdout.strip())


def _only_the_block(repo_root: Path, prd_root: Path) -> bool:
    """Is CLAUDE.md HEAD's CLAUDE.md with the managed block prd_block renders for the working PRD, and nothing else (the
    refresh `prd_hooks.py install` writes after `prd_change.py pack`, the block this approval would write itself)?"""
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    import prd_block

    head = subprocess.run(["git", "show", "HEAD:CLAUDE.md"], cwd=repo_root, capture_output=True)
    block = prd_block.render_block(model.load(prd_root), prd_root.relative_to(repo_root).as_posix())
    with tempfile.TemporaryDirectory(prefix="prd-approve-") as tmp:
        base = Path(tmp) / "CLAUDE.md"
        if head.returncode == 0:
            base.write_bytes(head.stdout)
        try:
            _, expected = prd_block._merged(base, block, "end")
        except prd_block.BlockError:
            return False
    claude = repo_root / "CLAUDE.md"
    return claude.is_file() and claude.read_bytes() == expected.encode("utf-8")  # a deleted CLAUDE.md is an uncommitted change


def _approved_text(text: str, last, dry_run: str) -> str:
    """The row's `pending` replaced by the record and the status Approved; the file's line ending (LF or CRLF) is kept."""
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    row = lines[last.line - 1]
    at = row.rfind(PENDING)
    lines[last.line - 1] = f"{row[:at]}; {dry_run.strip()}{row[at + len(PENDING):]}"
    end = lines.index("---", 1) if lines[0].strip() == "---" and "---" in lines[1:] else 0
    for n in range(1, end):
        if lines[n].startswith("status:"):
            lines[n] = "status: Approved"
    return eol.join(lines)


def _git(repo_root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo_root, capture_output=True, text=True, encoding="utf-8")


def _ignored(repo_root: Path, path: str) -> bool:
    """True when git ignores `path`: `status` hides it and `add` refuses it, so approve neither checks nor stages it."""
    return _git(repo_root, "check-ignore", "-q", "--", path).returncode == 0


def _message(slug: str, version: str, reply: str, dry_run: str, refs: str | None) -> str:
    trailer = f"Refs: {refs}" if refs else NO_REFS
    # the trace rule reads every line that starts with `Refs:`; one space keeps a reply line from passing as a trailer
    reply = re.sub(r"^(?=Refs:)", " ", reply, flags=re.M)
    return f'docs(prd): approve {slug} {version}\n\nReply: "{reply}"\nDry run: {dry_run.strip()}\n\n{trailer}\n'


def _block(prd_root: Path) -> None:
    run = subprocess.run([sys.executable, str(SCRIPTS / "prd_block.py"), str(prd_root)], capture_output=True, text=True, encoding="utf-8")
    if run.returncode != 0:
        _fail(f"prd_block failed: {run.stderr.strip()}")


def _vendored_packs(repo_root: Path, prd_root: Path) -> list[str]:
    """The re-vendored copy of each pack whose version the change moved, or the vendored copy of the pack a lift named
    (AC-060.9), and pack-sources.json: the paths `install` wrote."""
    from . import change
    from .hooks import PACK_SOURCES, PACKS_DIR, VENDOR_DIR

    names = change.pack_moves(repo_root, prd_root, "HEAD")
    lifted = change.pack_lift(repo_root, prd_root, "HEAD")
    if lifted is not None and lifted not in names:
        names.append(lifted)
    out = [f"{VENDOR_DIR}/{PACKS_DIR}/{name}" for name in names]
    if out:
        out.append(f"{VENDOR_DIR}/{PACK_SOURCES}")
    return [p for p in out if (repo_root / p).exists() and not _ignored(repo_root, p)]


def _commit(repo_root: Path, prd_root: Path, message: str, with_claude: bool) -> str:
    """Commit the PRD folder (never its verdict), CLAUDE.md when `with_claude` (prd_block changed its bytes), and the
    re-vendored pack of a change that moved a pack version."""
    rel = prd_root.relative_to(repo_root).as_posix()
    review = f"{rel}/{REVIEW_FILE}"
    paths = [rel, f":(exclude){review}", *_vendored_packs(repo_root, prd_root)]
    if with_claude and not _ignored(repo_root, "CLAUDE.md"):
        paths.append("CLAUDE.md")
    parent = prd_root.parent / "README.md"  # the parent's block, written beside the PRD's own README (which `rel` covers)
    if prd_root.parent.name == "prd" and parent.exists():
        parent_rel = parent.relative_to(repo_root).as_posix()
        if not _ignored(repo_root, parent_rel):
            paths.append(parent_rel)
    # `git add` exits 1 on a pathspec that names an ignored file, even an exclude one; git skips an ignored verdict anyway
    ignored = _ignored(repo_root, review)
    add_paths = [p for p in paths if not (ignored and p.startswith(":(exclude)"))]
    added = _git(repo_root, "add", "--", *add_paths)
    if added.returncode != 0:
        _git(repo_root, "reset", "-q", "--", *add_paths)  # a failed add can still have staged some paths
        _fail(f"git add failed: {added.stderr.strip()}")
    with tempfile.TemporaryDirectory(prefix="prd-approve-") as tmp:
        msg = Path(tmp) / "message"
        msg.write_text(message, encoding="utf-8")
        done = _git(repo_root, "commit", "-q", "--cleanup=verbatim", "-F", str(msg), "--", *paths)
    if done.returncode != 0:
        _git(repo_root, "reset", "-q", "--", *paths)
        _fail(f"git commit failed: {(done.stderr or done.stdout).strip()}")
    return _git(repo_root, "rev-parse", "HEAD").stdout.strip()


def approve(repo_root: Path, prd_root: Path, reply: str, dry_run: str, refs: str | None = None) -> Approved:
    """Approve the recorded change: all checks, then the row, status, CLAUDE.md block, commit and removal of the verdict."""
    repo_root, prd_root = Path(repo_root).resolve(), Path(prd_root).resolve()
    last = _checked(repo_root, prd_root, reply, dry_run)
    md_path, claude = prd_root / "prd.md", repo_root / "CLAUDE.md"
    old_md = md_path.read_bytes()
    old_claude = claude.read_bytes() if claude.exists() else None
    readmes = [prd_root / "README.md", prd_root.parent / "README.md"] if prd_root.parent.name == "prd" else [prd_root / "README.md"]
    old_readmes = {r: r.read_bytes() if r.exists() else None for r in readmes}  # prd_block writes both; a failure puts them back
    version = last.cells[0]
    try:
        md_path.write_bytes(_approved_text(old_md.decode("utf-8"), last, dry_run).encode("utf-8"))
        _block(prd_root)
        changed = (claude.read_bytes() if claude.exists() else None) != old_claude or _claude_dirty(repo_root)
        sha = _commit(repo_root, prd_root, _message(prd_root.name, version, reply, dry_run, refs), changed)
    except BaseException:
        md_path.write_bytes(old_md)
        if old_claude is None:
            claude.unlink(missing_ok=True)
        else:
            claude.write_bytes(old_claude)
        for r, old in old_readmes.items():
            if old is None:
                r.unlink(missing_ok=True)
            else:
                r.write_bytes(old)
        raise
    (prd_root / REVIEW_FILE).unlink(missing_ok=True)
    return Approved(sha)
