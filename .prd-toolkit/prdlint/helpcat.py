"""The help catalogue: every field of the PRD grammar, read from help.yaml and checked before use (FR-036, FR-037)."""
import os
from pathlib import Path

from . import registry
from .deps import require

SCRIPTS = Path(__file__).resolve().parent.parent
PLUGIN_ROOT = SCRIPTS.parent
SETTING = "PRD_HELP_FILE"
FIELDS = ("key", "name", "what", "why")  # required, each a non-empty string
LISTS = ("rules", "checked_by")  # optional, each a list of strings; an empty one counts as absent
OPTIONAL = (*LISTS, "see")


class CatalogueError(Exception):
    """A catalogue that cannot be used; the message reads `<path>: <reason>` (AC-036.3)."""


def is_plugin() -> bool:
    """True when running from the plugin: this directory is `scripts` and its parent holds .claude-plugin/plugin.json."""
    return SCRIPTS.name == "scripts" and (PLUGIN_ROOT / ".claude-plugin/plugin.json").is_file()


def path() -> tuple[Path, str]:
    """The catalogue to read and the path its messages name: PRD_HELP_FILE as given when set and not empty (AC-037.1),
    else the shipped one by its absolute path, references/help.yaml in the plugin, help.yaml beside a vendored copy's
    scripts (AC-037.2)."""
    named = os.environ.get(SETTING, "")
    if named:
        return Path(named), named
    shipped = PLUGIN_ROOT / "references/help.yaml" if is_plugin() else SCRIPTS / "help.yaml"
    return shipped, str(shipped)


def rules() -> dict[str, dict[str, str]]:
    """Every registered rule, sorted by name: its severity and its description ("" when it was registered without one)."""
    from . import rules as _rules  # noqa: F401  (importing registers every rule module)

    return {name: {"severity": registry.SEVERITY.get(name, "error"), "description": registry.DESCRIPTION.get(name, "")}
            for name in sorted(registry.RULES)}


def _strings(value) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _problem(data, known: set[str]) -> str | None:
    """The first reason the parsed catalogue cannot be used, in AC-036.3's order, or None."""
    if not isinstance(data, list):
        return "top level must be a list"
    seen: set[str] = set()
    for n, entry in enumerate(data, 1):
        if not isinstance(entry, dict):
            return f"entry {n}: must be a mapping"
        for field in FIELDS:
            if not isinstance(entry.get(field), str) or not entry[field]:
                return f"entry {n}: missing '{field}'"
        for field in LISTS:
            if field in entry and not _strings(entry[field]):
                return f"entry {n}: '{field}' must be a list of strings"
        if "see" in entry and not isinstance(entry["see"], str):
            return f"entry {n}: 'see' must be a string"
        if entry["key"] in seen:
            return f"entry {n}: duplicate key '{entry['key']}'"
        seen.add(entry["key"])
        unknown = next((r for r in entry.get("checked_by") or [] if r not in known), None)
        if unknown is not None:
            return f"entry {n}: checked_by names no rule '{unknown}'"
    return None


def _entry(raw: dict) -> dict:
    """The fields the catalogue format names, in its order; an empty `rules` or `checked_by` is left out (AC-035.1)."""
    out = {field: raw[field] for field in FIELDS}
    for field in OPTIONAL:
        if field in raw and (field == "see" or raw[field]):
            out[field] = raw[field]
    return out


def load() -> list[dict]:
    """The catalogue's entries, in file order, each holding only the fields of the format; CatalogueError when it
    cannot be used."""
    yaml = require("yaml", "pyyaml")
    where, shown = path()
    if not where.is_file():
        raise CatalogueError(f"{shown}: no such file")
    try:
        raw = where.read_bytes()
    except OSError as e:  # there, and reading it fails: the operating system's text, e.g. Permission denied (AC-036.3)
        raise CatalogueError(f"{shown}: cannot read: {e.strerror or e}") from None
    try:
        data = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        problem = getattr(e, "problem", None) or (str(e).splitlines() or ["not valid YAML"])[0]
        raise CatalogueError(f"{shown}: YAML parse error: {problem}") from None
    reason = _problem(data, set(rules()))
    if reason:
        raise CatalogueError(f"{shown}: {reason}")
    return [_entry(e) for e in data]


def checks(entries: list[dict], rule: str) -> list[dict]:
    """The entries that name `rule` in `checked_by`, in the catalogue's order."""
    return [e for e in entries if rule in e.get("checked_by", [])]
