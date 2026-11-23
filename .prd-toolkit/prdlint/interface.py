"""The machine interface: one JSON document per call, versioned, shared by every interface script."""
import contextlib
import io
import json
import re
import sys
from collections.abc import Callable

INTERFACE = 1
_PREFIX = re.compile(r"^(?:prd_\w+(?:\.py)?(?: \w[\w-]*)?): (?:error: )?")


def dump(kind: str, payload: dict) -> str:
    """One line of JSON with `interface` and `kind` first."""
    return json.dumps({"interface": INTERFACE, "kind": kind, **payload}, ensure_ascii=False) + "\n"


def error(kind: str, message: str) -> str:
    return dump(kind, {"error": message})


def add_flags(parser) -> None:
    parser.add_argument("--json", action="store_true", help="print one JSON document (interface 1); --json=N asks for interface N")
    parser.add_argument("--interface", action="store_true", help="print the interface version and exit")


def wants_json(argv: list[str]) -> bool:
    return any(a == "--json" or a.startswith("--json=") for a in argv)


def split_argv(argv: list[str]) -> tuple[list[str], str | None]:
    """Turn each `--json=N` into a plain `--json`; return the argv and the last N asked for (None if none)."""
    out, version = [], None
    for a in argv:
        if a.startswith("--json="):
            version = a[len("--json="):]
            a = "--json"
        out.append(a)
    return out, version


def check_version(value: str | None) -> str | None:
    """The error text for an unsupported interface N, or None."""
    if value is None or value == str(INTERFACE):
        return None
    return f"unsupported interface {value}; this toolkit speaks {INTERFACE}"


def subcommand_kind(argv: list[str], kinds: dict[str, str], fallback: str) -> str:
    """The document kind of the first non-option argument when it names a subcommand in `kinds`, else `fallback`."""
    first = next((a for a in argv if not a.startswith("-")), None)
    return kinds.get(first, fallback)


def run(main_text: Callable[[list[str]], int], kind: str, argv: list[str]) -> int:
    """Call main_text; when JSON is wanted, turn an exit-2 path into the error document. Stderr keeps its text.

    When main_text already printed a document on stdout (an owner's exit 2 passed through), no second one is added."""
    if not wants_json(argv):
        return main_text(argv)
    captured, printed = io.StringIO(), io.StringIO()
    with contextlib.redirect_stderr(captured), contextlib.redirect_stdout(printed):
        code = main_text(argv)
    text = captured.getvalue()
    sys.stderr.write(text)
    sys.stdout.write(printed.getvalue())
    if code == 2 and not printed.getvalue().strip():
        lines = [ln for ln in text.strip().splitlines() if ln.strip()]
        pick = next((ln for ln in lines if re.match(r"^prd_\w+\.py(?: \w[\w-]*)?: error: ", ln)), lines[0] if lines else "usage error")
        message = _PREFIX.sub("", pick)
        sys.stdout.write(error(kind, message))
    return code
