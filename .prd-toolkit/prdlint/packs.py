"""Packs: the pack.yaml manifest, the target profile of an area, and resolving a named pack (spec sections 3 and 4)."""
import json
import os
import re
import shlex
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import languages
from .hooks import PACKS_DIR, PLUGIN_ROOT, SCRIPTS, VENDOR_DIR, is_plugin, plugin_version, vendored_sources
from .model import PackRef, Prd, repo_root
from .yamlload import load_yaml

MANIFEST = "pack.yaml"
PLUGIN_PACKS = "prd-packs"  # <installPath>/prd-packs/<name>/ in an installed plugin
BUILT_IN = "prd-toolkit"  # the source of a built-in pack
UNRECORDED = "source not recorded"  # a vendored pack with no pack-sources.json entry (vendored before the record)
SERVICE_DEFAULT = PackRef("service", None, BUILT_IN, "", 0)  # no Pack: line; not locked
KEYS = ("pack", "version", "toolkit", "description", "contract-types", "target-kinds", "levels", "harness", "standards",
        "skills", "vocabulary", "builder-tests", "rubrics", "clarify", "grader", "languages", "sources")
LISTS = ("contract-types", "levels", "standards", "skills", "vocabulary", "sources")
MAPPINGS = ("target-kinds", "harness")
ITEM_KEYS = {"levels": ("level", "command"), "standards": ("object", "linter"), "skills": ("activity", "skill"),
             "sources": ("title", "location", "covers")}  # sources: read by no script; the skill proposes them (FR-056)
_VERSION = re.compile(r"\d+\.\d+\.\d+")
_CLAUSE = re.compile(r"\s*(>=|<=|==|!=|>|<)\s*(\d+(?:\.\d+){0,2})\s*")


class ManifestError(Exception):
    """A pack.yaml that fails its schema, or whose toolkit range excludes this toolkit; `.key` names the key."""

    def __init__(self, key: str, message: str):
        super().__init__(message)
        self.key = key


class PackNotFound(Exception):
    def __init__(self, ref: PackRef, looked: list[str]):
        at = f" {ref.version}" if ref.version else ""
        super().__init__(f"pack {ref.name}{at} ({ref.source}) not found; looked in: {', '.join(looked)}")
        self.looked = looked


class PackMismatch(Exception):
    def __init__(self, name: str, vendored: str, named: str):
        super().__init__(f"vendored {name} {vendored}, the PRD names {named}; run prd_hooks.py install")
        self.vendored = vendored
        self.named = named


@dataclass
class Pack:
    name: str
    version: str
    root: Path
    source: str
    data: dict

    def _path(self, key: str) -> Path | None:
        return self.root / self.data[key] if self.data.get(key) else None

    @property
    def description(self) -> str:
        return self.data.get("description") or ""

    @property
    def contract_types(self) -> list[dict]:
        return list(self.data.get("contract-types") or [])

    @property
    def target_kinds(self) -> dict[str, str]:
        return dict(self.data.get("target-kinds") or {})

    @property
    def levels(self) -> list[dict]:
        return list(self.data.get("levels") or [])

    @property
    def harness(self) -> dict[str, str]:
        return dict(self.data.get("harness") or {})

    @property
    def standards(self) -> list[dict]:
        return list(self.data.get("standards") or [])

    @property
    def skills(self) -> list[dict]:
        return list(self.data.get("skills") or [])

    @property
    def vocabulary(self) -> list[str]:
        return list(self.data.get("vocabulary") or [])

    @property
    def builder_tests(self) -> str:
        return self.data.get("builder-tests") or "unit"

    @property
    def rubrics(self) -> Path | None:
        return self._path("rubrics")

    @property
    def clarify(self) -> Path | None:
        return self._path("clarify")

    @property
    def grader(self) -> str | None:
        return self.data.get("grader") or None

    @property
    def languages_dir(self) -> Path | None:
        return self._path("languages")


def toolkit_packs_dir() -> Path:
    """The toolkit's own packs: `packs/` in the plugin, `.prd-toolkit/packs/` (beside the scripts) when vendored."""
    return PLUGIN_ROOT / "packs" if is_plugin() else SCRIPTS / "packs"


def toolkit_version() -> str:
    """This toolkit's version: plugin.json from the plugin, else the vendored VERSION file; 0.0.0 when neither reads."""
    try:
        return plugin_version(PLUGIN_ROOT) if is_plugin() else (SCRIPTS / "VERSION").read_text(encoding="utf-8").strip()
    except (OSError, ValueError, KeyError):
        return "0.0.0"


def _parts(v: str) -> tuple[int, int, int]:
    nums = [int(x) for x in v.split(".")]
    return tuple(nums + [0] * (3 - len(nums)))  # type: ignore[return-value]


def in_range(version: str, spec: str) -> bool:
    """`version` satisfies every comma-separated clause of `spec` (>=, >, <=, <, ==, !=). ValueError on a bad spec."""
    if not _VERSION.fullmatch(version.strip()):
        raise ValueError(f"not a version: {version!r}")
    have = _parts(version.strip())
    ok = True
    for clause in spec.split(","):
        m = _CLAUSE.fullmatch(clause)
        if not m:
            raise ValueError(f"not a version range: {spec!r}")
        want = _parts(m.group(2))
        ok &= {">=": have >= want, ">": have > want, "<=": have <= want, "<": have < want,
               "==": have == want, "!=": have != want}[m.group(1)]
    return ok


def installed_plugins() -> dict[str, list]:
    """`$PRD_PLUGINS_FILE` or ~/.claude/plugins/installed_plugins.json as {"<plugin>@<marketplace>": [install, ...]}, in
    file order; an entry that is a single install becomes a one-item list. {} when the file is missing or unreadable."""
    path = Path(os.environ.get("PRD_PLUGINS_FILE") or Path.home() / ".claude/plugins/installed_plugins.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    plugins = data.get("plugins", data) if isinstance(data, dict) else {}
    if not isinstance(plugins, dict):
        return {}
    return {str(k): (v if isinstance(v, list) else [v]) for k, v in plugins.items()}


def _install_paths(installs: list) -> list[Path]:
    return [Path(i["installPath"]) for i in installs if isinstance(i, dict) and isinstance(i.get("installPath"), str)]


def _strings(v: Any) -> bool:
    return isinstance(v, str) or (isinstance(v, list) and all(isinstance(x, str) for x in v))


def load_manifest(folder: Path, source: str) -> Pack:
    """Load and check `folder/pack.yaml` against the spec section 4 schema and this toolkit's version."""
    from .rules.structure import HARNESS_SLOTS  # local: the rules package imports this module

    folder = Path(folder)
    name = folder.name

    def bad(key: str, msg: str):
        raise ManifestError(key, f"pack {name}: {MANIFEST}: {msg}")

    path = folder / MANIFEST
    if not path.is_file():
        bad(MANIFEST, "is missing")
    data, problems = load_yaml(path, MANIFEST)
    if data is None or problems:
        bad(MANIFEST, problems[0].message if problems else "top level must be a mapping")
    for key in data:
        if key not in KEYS:
            bad(str(key), f"unknown key {key}")
    for key in ("pack", "version", "toolkit"):
        if data.get(key) is None:
            bad(key, f"{key} is required")
    if data["pack"] != name:
        bad("pack", f"pack must equal the folder name {name}")
    if not isinstance(data["version"], str) or not _VERSION.fullmatch(data["version"]):
        bad("version", "version must be X.Y.Z")
    for key in ("description", "grader"):
        if key in data and not isinstance(data[key], str):
            bad(key, f"{key} must be a string")
    for key in LISTS:
        if key in data and not isinstance(data[key], list):
            bad(key, f"{key} must be a list")
    for key in MAPPINGS:
        if key in data and not isinstance(data[key], dict):
            bad(key, f"{key} must be a mapping")
    types: list[str] = []
    for i, ct in enumerate(data.get("contract-types") or []):
        if not (isinstance(ct, dict) and isinstance(ct.get("type"), str) and _strings(ct.get("files"))
                and isinstance(ct.get("validator"), str)):
            bad("contract-types", f"contract-types[{i}] must be a mapping with type, files and validator")
        types.append(ct["type"])
    for key, need in ITEM_KEYS.items():
        for i, item in enumerate(data.get(key) or []):
            if not (isinstance(item, dict) and all(isinstance(item.get(k), str) for k in need)):
                bad(key, f"{key}[{i}] must be a mapping with {', '.join(need[:-1])} and {need[-1]}")
    for i, item in enumerate(data.get("levels") or []):
        if "timeout" in item and not (type(item["timeout"]) is int and item["timeout"] >= 1):  # bool is not a timeout
            bad("levels", f"levels[{i}]: timeout must be a whole number of seconds of at least 1")
    if not all(isinstance(w, str) and w.strip() for w in data.get("vocabulary") or []):
        bad("vocabulary", "vocabulary must be a list of words")
    for kind, ctype in (data.get("target-kinds") or {}).items():
        if not isinstance(kind, str) or ctype not in types:
            bad("target-kinds", f"target-kinds: {kind} maps to {ctype}, not a contract type of this pack")
    for slot, text in (data.get("harness") or {}).items():
        if slot not in HARNESS_SLOTS:
            bad("harness", f"harness: '{slot}' is not a Harness slot")
        if not isinstance(text, str):
            bad("harness", f"harness: '{slot}' must be a string")
    if data.get("builder-tests", "unit") not in ("unit", "none"):
        bad("builder-tests", "builder-tests must be unit or none")
    for key, kind in (("rubrics", "file"), ("clarify", "file"), ("languages", "folder")):
        if key not in data:
            continue
        rel = data[key]
        target = (folder / rel).resolve() if isinstance(rel, str) and rel else None
        inside = target is not None and target.is_relative_to(folder.resolve())
        if not (inside and (target.is_file() if kind == "file" else target.is_dir())):
            bad(key, f"{key}: {rel} is not a {kind} in the pack")
    toolkit, have = data["toolkit"], toolkit_version()
    try:
        fits = isinstance(toolkit, str) and in_range(have, toolkit)
    except ValueError:
        fits = None
    if fits is None or not isinstance(toolkit, str):
        bad("toolkit", "toolkit must be a version range such as >=0.8.0,<0.9: "
                       "comma-separated clauses of >=, >, <=, <, == or != and a version X, X.Y or X.Y.Z")
    if not fits:
        raise ManifestError("toolkit", f"pack {name} needs toolkit {toolkit}; this is {have}")
    if name != "service" and any(ct["validator"] == "built-in" for ct in data.get("contract-types") or []):
        raise ManifestError("contract-types", f"pack {name}: only the service pack may use validator built-in")
    return Pack(name, data["version"], folder, source, data)


def _peek_version(folder: Path) -> str | None:
    """The `version:` of folder/pack.yaml without checking the rest; None when it does not read."""
    data, _ = load_yaml(folder / MANIFEST, MANIFEST)
    v = data.get("version") if isinstance(data, dict) else None
    return v if isinstance(v, str) else None


def _plugin_candidates(source: str) -> tuple[list[Path], str | None]:
    """The prd-packs/ folders of plugin `source`'s installs, or ([], why) when it has none to look in."""
    installs = installed_plugins().get(source)
    paths = [p / PLUGIN_PACKS for p in _install_paths(installs or [])]
    if paths:
        return paths, None
    return [], f"plugin {source} ({'not installed' if installs is None else 'no installPath'})"


def resolve(ref: PackRef, repo_root: Path, vendored: bool = True) -> Pack:
    """The pack `ref` names (spec section 4): the vendored copy when the repository has .prd-toolkit/ (the only
    candidate once it holds the pack), then the toolkit's own packs/ for source prd-toolkit, or the prd-packs/ of plugin
    `<plugin>@<marketplace>` for any other source. A version of None (the service default) takes the first hit,
    unlocked. PackNotFound lists only the places looked in."""
    looked: list[str] = []
    vend = Path(repo_root) / VENDOR_DIR / "packs" / ref.name
    if vendored and (Path(repo_root) / VENDOR_DIR).is_dir():
        if (vend / MANIFEST).is_file():
            have = _peek_version(vend)
            if ref.version is not None and have != ref.version:
                raise PackMismatch(ref.name, have or "(no version)", ref.version)
            return load_manifest(vend, ref.source)
        if vend.is_dir():  # a vendored folder that lost its manifest never falls through to another copy
            raise ManifestError(MANIFEST, f"vendored {ref.name} has no {MANIFEST}; run prd_hooks.py install")
        looked.append(f"{vend}/")
    if ref.source == BUILT_IN:
        bases, missing = [toolkit_packs_dir()], None
    else:
        bases, missing = _plugin_candidates(ref.source)
    for base in bases:
        folder = base / ref.name
        if looked and looked[0] == f"{vend}/" and folder.resolve() == vend.resolve():
            continue  # running vendored: the toolkit's own packs/ is the vendored folder, already looked in
        if (folder / MANIFEST).is_file():
            have = _peek_version(folder)
            if ref.version is None or have == ref.version:
                return load_manifest(folder, ref.source)
            looked.append(f"{folder}/ (holds {have})")
        else:
            looked.append(f"{folder}/")
    if missing:
        looked.append(missing)
    raise PackNotFound(ref, looked)


def named(prd: Prd) -> list[PackRef]:
    """Every pack the PRD names, section 1 first and then each area's Target: in file order; one ref per
    (name, version, source), at its first line."""
    refs = ([prd.pack_ref] if prd.pack_ref else []) + [t.pack for _, t in sorted(prd.targets.items(), key=lambda kv: kv[1].file) if t.pack]
    out: list[PackRef] = []
    seen: set[tuple] = set()
    for r in refs:
        if (r.name, r.version, r.source) not in seen:
            seen.add((r.name, r.version, r.source))
            out.append(r)
    return out


def profile(prd: Prd, area: str | None) -> tuple[PackRef, str]:
    """(pack ref, output language) of `area`, or of section 1 when `area` is None: the area's Target: parts, else
    section 1's lines, else the service default and the PRD's `language:`."""
    pack = prd.pack_ref or SERVICE_DEFAULT
    lang = prd.output_language[0] if prd.output_language else languages.code(prd)
    t = prd.targets.get(area) if area else None
    return (t.pack if t and t.pack else pack), (t.output_language if t and t.output_language else lang)


_FAILURES = (ManifestError, PackNotFound, PackMismatch, OSError, ValueError)


def resolve_cached(prd: Prd, ref: PackRef) -> Pack:
    """`resolve(ref, repo_root)`, once per (name, version, source) per loaded PRD: the Pack, or the failure re-raised."""
    cache = prd.__dict__.setdefault("_resolved", {})
    key = (ref.name, ref.version, ref.source)
    if key not in cache:
        try:
            cache[key] = resolve(ref, repo_root(prd.root))
        except _FAILURES as e:
            cache[key] = e
    got = cache[key]
    if isinstance(got, Exception):
        raise got
    return got


def pack_for(prd: Prd, area: str | None) -> Pack | None:
    """The resolved pack of `area`'s profile; None on any failure (pack-resolves reports it)."""
    try:
        return resolve_cached(prd, profile(prd, area)[0])
    except _FAILURES:
        return None


def languages_dirs(prd: Prd) -> list[Path]:
    """The `languages:` folder of each named pack that resolves, in named order."""
    refs = named(prd)
    if not refs:
        return []
    out = []
    for ref in refs:
        try:
            d = resolve_cached(prd, ref).languages_dir
        except _FAILURES:
            continue
        if d:
            out.append(d)
    return out


def expand(cmd: str, pack: Pack) -> list[str]:
    """`cmd` split as a shell would (shlex), then `${PACK}` replaced in each argument: a spaced path stays one argument."""
    return [arg.replace("${PACK}", str(pack.root)) for arg in shlex.split(cmd)]


def discover() -> list[Pack]:
    """Every pack on this machine: the toolkit's own, then each installed plugin's prd-packs/, in installed_plugins.json
    order. A pack.yaml that fails its checks is skipped with a note on stderr. Run from a vendored copy, the toolkit's
    own packs are the ones vendored in .prd-toolkit/packs/, each with the source pack-sources.json records for it, and a
    note on stderr says so."""
    out: list[Pack] = []
    seen: set[tuple] = set()

    def add(folder: Path, source: str) -> None:
        try:
            pack = load_manifest(folder, source)
        except (ManifestError, OSError, ValueError) as e:
            print(f"prd_lint: skipped {folder}: {e}", file=sys.stderr)
            return
        if (pack.name, pack.version, pack.source) not in seen:
            seen.add((pack.name, pack.version, pack.source))
            out.append(pack)

    vendored = not is_plugin()
    recorded = vendored_sources(SCRIPTS) if vendored else {}
    for f in sorted(toolkit_packs_dir().glob(f"*/{MANIFEST}")):
        add(f.parent, recorded.get(f.parent.name, UNRECORDED) if vendored else BUILT_IN)
    if vendored:
        names = [p.name for p in out]
        if names:
            listed = ", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else names[0]
            what = (f"{listed} {'are' if len(names) > 1 else 'is'} vendored in {VENDOR_DIR}/{PACKS_DIR}/, "
                    "each with the source it was vendored from")
        else:
            what = f"no pack is vendored in {VENDOR_DIR}/{PACKS_DIR}/"
        print(f"prd_lint: listed from the vendored copy: {what}; the plugin's own scripts/prd_lint.py --list-packs "
              "lists every pack on this machine", file=sys.stderr)
    for key, installs in installed_plugins().items():
        for p in _install_paths(installs):
            for f in sorted((p / PLUGIN_PACKS).glob(f"*/{MANIFEST}")):
                add(f.parent, key)
    return out
