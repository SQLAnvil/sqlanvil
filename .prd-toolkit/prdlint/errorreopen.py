"""Taking a confirmation back (error-reopen): `prd error reopen` swaps an entry's `Confirmed:` line for a `Reopened:` line
that keeps it word for word, so the entry is `proposed` again; `prd error check` accepts that write, and reports an edited,
deleted or unmatched `Reopened:` line."""
import re
from datetime import date

from .deploy import Refused
from .model import ErrorEntry, Prd, _errors_ledger

WAS = "; was Confirmed:"
# AC-146.4: <date>, "<reason>"; was Confirmed: <date>, "<reply>", the reply's closing quote ending the value
FORM = re.compile(r'\d{4}-\d{2}-\d{2}, ".*"; was Confirmed: \d{4}-\d{2}-\d{2},\s*".*"')
FORM_MESSAGE = "Reopened: must be '<YYYY-MM-DD>, \"<reason>\"; was Confirmed: <YYYY-MM-DD>, \"<reply>\"'"
_OPENS_FENCE = re.compile(r"^(```|~~~)")


def collapse(text: str) -> str:
    """Each run of white space, line breaks included, made one space, and the white space around it removed."""
    return " ".join(text.split())


def reopen(prd: Prd, eid: str, reason: str, today: date) -> None:
    """FR-251: write `Reopened: <today>, "<why>"; was Confirmed: <value>` in place of the entry's Confirmed: line."""
    why = collapse(reason)
    if not why:
        raise ValueError("the reason is empty")
    if _OPENS_FENCE.match(why):
        raise Refused(["--reason would open a code fence; drop it or put text before it"])
    if WAS in why:
        raise Refused([f'--reason must not hold "{WAS}"'])
    path = prd.root / "errors.md"
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    e = _errors_ledger(text).get(eid)
    if e is None:
        raise Refused([f"{eid} is not an entry"])
    if e.state == "resolved":
        raise Refused([f"{eid} is resolved"])
    if e.state != "confirmed":
        raise Refused([f"{eid} is not confirmed"])
    lines = text.split("\n")
    lines[e.confirmed_line - 1] = f'Reopened: {today.isoformat()}, "{why}"{WAS} {e.confirmed_raw}'
    path.write_text("\n".join(lines), encoding="utf-8")


def findings(a: ErrorEntry, b: ErrorEntry) -> tuple[bool, list[str]]:
    """FR-252, one entry in two versions: (whether the write is a reopen of a's Confirmed:, the Reopened: findings)."""
    old, new = [raw for raw, _ in a.reopened], [raw for raw, _ in b.reopened]
    if new[:len(old)] != old:
        return False, ["Reopened: changed"]
    more = new[len(old):]
    if not more:
        return False, []
    value = lambda raw: raw.split(":", 1)[1].strip()  # noqa: E731
    if a.confirmed_raw is not None and len(more) == 1 and value(more[0]).endswith(f"{WAS} {a.confirmed_raw}"):
        return True, []
    return False, ["Reopened: added without its Confirmed:"]
