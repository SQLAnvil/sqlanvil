"""PRD language tables: EARS openers and vague words per language (`language:` in the PRD frontmatter)."""
import re
from dataclasses import dataclass
from pathlib import Path

from .deps import require

SCRIPTS = Path(__file__).resolve().parent.parent
PLUGIN_ROOT = SCRIPTS.parent


def is_plugin() -> bool:
    """True when running from the plugin: this directory is `scripts` and its parent holds .claude-plugin/plugin.json."""
    return SCRIPTS.name == "scripts" and (PLUGIN_ROOT / ".claude-plugin/plugin.json").is_file()


def toolkit_dir() -> Path:
    """The toolkit's own tables: `references/languages/` in the plugin, `languages/` beside the scripts when vendored."""
    return PLUGIN_ROOT / "references/languages" if is_plugin() else SCRIPTS / "languages"


TABLES_DIR = toolkit_dir()
_META = re.compile(r"([.^$*+?{}\[\]\\|()])")


@dataclass
class Table:
    code: str
    openers: list[str]
    ubiquitous: re.Pattern
    vague: re.Pattern
    labels: dict[str, str]
    ubiquitous_hint: str = ""
    modal: re.Pattern | None = None  # the verb every AC must carry; None skips that check
    modal_word: str = ""

    def opener(self) -> re.Pattern:
        return re.compile(r"^(?:" + "|".join(_META.sub(r"\\\1", o) for o in self.openers) + r")\b")

    def ears_message(self, ac_id: str) -> str:
        return f"{ac_id} must start with {', '.join(self.openers)} or {self.ubiquitous_hint}"


def _build(code: str, data: dict) -> Table:
    ears = data.get("ears") or {}
    words = "|".join(_META.sub(r"\\\1", w) for w in data.get("vague") or [])
    modal = ears.get("modal")
    return Table(
        code=code,
        openers=list(ears.get("openers") or []),
        ubiquitous=re.compile(ears["ubiquitous"]),
        vague=re.compile(rf"\b({words})\b", re.I),
        labels=dict(data.get("labels") or {}),
        ubiquitous_hint=ears.get("ubiquitous_hint", ""),
        modal=re.compile(modal) if modal else None,
        modal_word=ears.get("modal_word", ""),
    )


class TableError(Exception):
    """A table file that is present but cannot be used; the message reads `language table <path>: <problem>`."""


def load(code: str, extra_dirs=()) -> Table | None:
    """The table for `code`: the toolkit's own first, then each extra dir; None when none has it, TableError when a
    file is present but unreadable or malformed."""
    if not re.fullmatch(r"[a-z]{2,3}", code):
        return None
    yaml = require("yaml", "pyyaml")
    for d in (toolkit_dir(), *map(Path, extra_dirs)):
        path = d / f"{code}.yaml"
        if path.is_file():
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
                if not isinstance(data, dict):
                    raise TypeError("the top level must be a mapping")
                return _build(code, data)
            except KeyError as e:
                raise TableError(f"language table {path}: missing key {e.args[0]}") from None
            except yaml.YAMLError as e:
                raise TableError(f"language table {path}: {str(e).splitlines()[0] if str(e) else 'not valid YAML'}") from None
            except (OSError, ValueError, TypeError, AttributeError, re.error) as e:
                raise TableError(f"language table {path}: {e}") from None
    return None


def code(prd) -> str:
    return prd.frontmatter.get("language") or "en"


def pack_dirs(prd) -> list[Path]:
    """The `languages:` folders of the packs the PRD names, searched after the toolkit's own tables."""
    from . import packs  # local: packs imports this module

    return packs.languages_dirs(prd)


def problem(prd) -> str | None:
    """Why the PRD's language table cannot be used, or None. A broken table file is named; `en` missing is a
    problem too, since it backs every language without a table of its own."""
    lang = code(prd)
    if not re.fullmatch(r"[a-z]{2,3}", lang):
        return None
    try:
        own = load(lang, pack_dirs(prd))
        if own is None and lang != "en":
            if load("en") is None:
                return f"language table {toolkit_dir() / 'en.yaml'}: not found"
            return f"language '{lang}' has no table"
        if own is None:
            return f"language table {toolkit_dir() / 'en.yaml'}: not found"
    except TableError as e:
        return str(e)
    return None


def for_prd(prd) -> Table | None:
    """The PRD's language table, or `en` when `language:` has no table; None when no table can be used (the
    language-table rule reports why, and the rules that need a table skip)."""
    try:
        return load(code(prd), pack_dirs(prd)) or load("en")
    except TableError:
        return None
