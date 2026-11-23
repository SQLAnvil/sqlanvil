"""Contract items per kind: list them, extract cited ones into snapshot file bodies, render one's canonical text.

The single place that knows how each contract kind is laid out. Comparison goes through `item_text`, which
normalises formatting (SQL re-rendered by sqlglot, YAML dumped with sorted keys) so a reformatted item is
the same and a changed one differs.
"""
from dataclasses import dataclass

from .deps import require
from .markdown import strip_code
from .model import CROSSING, Prd, SnapshotFile
from .rules.contracts import _EVENT_HEADING, _METHODS, create_tables, custom_types, operations_of, parse_schema

yaml = require("yaml", "pyyaml")
from sqlglot import Dialect, TokenType, exp  # noqa: E402

_REF = "#/components/"


@dataclass
class Contracts:
    files: dict[str, str]  # contract file name (relative to contracts/) -> text
    types: dict[str, str]  # custom kind -> its file name
    dialect: str | None


class Missing(Exception):
    def __init__(self, items: list[tuple[str, str]]):
        super().__init__("; ".join(f"{k}:{n}" for k, n in items))
        self.items = items


def contracts_of(prd: Prd) -> Contracts:
    """The PRD's own contracts: the three crossing files and each custom type's first YAML-mapping file."""
    files: dict[str, str] = {}
    for name in ("schema.sql", "openapi.yaml", "events.md"):
        p = prd.root / "contracts" / name
        if p.is_file():
            files[name] = p.read_text(encoding="utf-8")
    types: dict[str, str] = {}
    for kind, _, found, _ in custom_types(prd):
        for f in found:
            if f.startswith("contracts/") and isinstance(prd.yaml.get(f), dict):
                name = f[len("contracts/"):]
                files[name] = (prd.root / f).read_text(encoding="utf-8")
                types.setdefault(kind, name)
                break
    return Contracts(files, types, prd.frontmatter.get("sql-dialect") or None)


def contracts_of_snapshot(snaps: list[SnapshotFile]) -> Contracts:
    """A snapshot folder's files; custom types and the dialect come from the headers."""
    files: dict[str, str] = {}
    types: dict[str, str] = {}
    dialect = None
    for s in snaps:
        name = s.rel.split("/", 3)[3] if s.rel.count("/") >= 3 else s.rel
        files[name] = s.text
        if s.header and s.header.get("type"):
            types[s.header["type"]] = name
        if s.header and s.header.get("dialect") and name == "schema.sql":
            dialect = s.header["dialect"]
    return Contracts(files, types, dialect)


# ---------------------------------------------------------------- parsing

def _norm(node):
    """Mapping keys as strings throughout, so a dump sorts a mapping that mixes 200 and default."""
    if isinstance(node, dict):
        return {str(k): _norm(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_norm(v) for v in node]
    return node


def _load(text: str | None):
    try:
        data = yaml.safe_load(text) if text is not None else None
    except yaml.YAMLError:
        return None
    return data if isinstance(data, dict) else None


def _statements(c: Contracts):
    text = c.files.get("schema.sql")
    return (parse_schema(text, c.dialect) or []) if text is not None else []


def _comment_table(stmt) -> str | None:
    """The table a COMMENT ON names, lowercased (a table name is matched without case, as `test-refs` does)."""
    if not isinstance(stmt, exp.Comment):
        return None
    target = stmt.this
    if isinstance(target, exp.Table):
        return target.name.lower()
    if isinstance(target, exp.Column):
        return target.table.lower()
    return None


def _table_sql(c: Contracts, name: str) -> list[str] | None:
    """Rendered statements of one table: its CREATE, then its COMMENT ON lines sorted."""
    stmts = _statements(c)
    name = name.lower()
    create = next((s for n, s in create_tables(stmts) if n.lower() == name), None)
    if create is None:
        return None
    comments = sorted(s.sql(dialect=c.dialect, pretty=True) for s in stmts if _comment_table(s) == name)
    return [create.sql(dialect=c.dialect, pretty=True)] + comments


def _chunks(c: Contracts):
    """(source text, parsed statement) for each statement of schema.sql, the text exactly as written.

    A same-line `--` comment after a statement's semicolon goes with that statement; of the text before
    a statement only the `--` lines directly above it (no blank line between) go with it.
    Raises when the file does not tokenize."""
    text = c.files.get("schema.sql")
    if text is None:
        return []
    tokens = Dialect.get_or_raise(c.dialect).tokenize(text)
    out, prev, first, ended = [], 0, None, False
    spans = []  # (start of first token, end of the semicolon, end including a same-line comment, has semicolon)
    for t in tokens:
        if first is None:
            first = t.start
        if t.token_type == TokenType.SEMICOLON:
            semi = t.end + 1
            eol = text.find("\n", semi)
            eol = len(text) if eol < 0 else eol
            rest = text[semi:eol].strip()
            spans.append((first, semi, eol if rest.startswith("--") or not rest else semi, True))
            first = None
    if first is not None:
        spans.append((first, len(text.rstrip()), len(text.rstrip()), False))
    for start, semi, cut, has_semi in spans:
        above = []
        for line in reversed(text[prev:start].split("\n")[:-1]):
            if not line.strip().startswith("--"):
                break
            above.insert(0, line.strip())
        prev = max(cut, semi)
        body = text[start:cut].rstrip()
        parsed = parse_schema(text[start:semi], c.dialect)
        if parsed and parsed[0] is not None:
            out.append(("\n".join(above + [body + ("" if has_semi else ";")]), parsed[0]))
    return out


def _sections(text: str) -> list[tuple[str, list[str]]]:
    """(name, lines) for each `### name` section of events.md, up to the next heading of level 1-3."""
    lines, stripped = text.split("\n"), strip_code(text).split("\n")
    out: list[tuple[str, list[str]]] = []
    for line, st in zip(lines, stripped):
        if st.startswith("#") and st.lstrip("#").startswith(" ") and len(st) - len(st.lstrip("#")) <= 3:
            m = _EVENT_HEADING.match(st)
            out.append((m.group(1), [line]) if m else ("", []))
        elif out and out[-1][0]:
            out[-1][1].append(line)
    return [(n, ls) for n, ls in out if n]


def _op(c: Contracts, name: str):
    """(data, section, path, method, operation) of operationId `name`, or None."""
    data = _load(c.files.get("openapi.yaml"))
    for oid, section, path, method, op in operations_of(data):
        if oid == name:
            return data, section, path, method, op
    return None


def _refs(node, out: list[str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str):
                out.append(v)
            else:
                _refs(v, out)
    elif isinstance(node, list):
        for v in node:
            _refs(v, out)


def _closure(data: dict, roots: list) -> tuple[dict[str, dict], list[str]]:
    """Components reachable from `roots` by `#/components/<section>/<name>` refs (breadth-first), and the
    refs that point anywhere else, which are noted and not followed."""
    comps = data.get("components") if isinstance(data.get("components"), dict) else {}
    found: dict[str, dict] = {}
    external: list[str] = []
    queue: list[str] = []
    _refs(roots, queue)
    seen: set[str] = set()
    while queue:
        ref = queue.pop(0)
        if ref in seen:
            continue
        seen.add(ref)
        parts = ref[len(_REF):].split("/") if ref.startswith(_REF) else []
        section = comps.get(parts[0]) if len(parts) == 2 else None
        if not isinstance(section, dict) or parts[1] not in section:
            external.append(ref)
            continue
        found.setdefault(parts[0], {})[parts[1]] = section[parts[1]]
        _refs(section[parts[1]], queue)
    return found, sorted(set(external))


def _op_view(data: dict, section: str, path: str, method: str, op: dict) -> dict:
    item = data[section][path]
    parameters = item.get("parameters")
    comps, external = _closure(data, [op, parameters])
    view = {"path": path, "method": method, "operation": op, "components": comps}
    if parameters:
        view["path_parameters"] = parameters
    if external:
        view["external_refs"] = external
    return view


# ---------------------------------------------------------------- public API

def items(c: Contracts) -> dict[str, set[str]]:
    """Kind -> names for the crossing kinds and each YAML custom type."""
    out: dict[str, set[str]] = {k: set() for k in CROSSING}
    out["table"] = {n.lower() for n, _ in create_tables(_statements(c))}  # matched without case, as test-refs does
    data = _load(c.files.get("openapi.yaml"))
    out["op"] = {oid for oid, *_ in operations_of(data)}
    names = {n for n, _ in _sections(c.files.get("events.md", ""))}
    out["event"], out["job"] = set(names), set(names)  # events.md does not tell an event from a job
    for kind, fname in c.types.items():
        d = _load(c.files.get(fname))
        if d is not None:
            out[kind] = {str(k) for k in d}
    return out


def item_text(c: Contracts, kind: str, name: str) -> str | None:
    """The canonical text compared by check and impact; None when the item is absent."""
    if kind == "table":
        sql = _table_sql(c, name)
        return None if sql is None else "\n".join(sql)
    if kind == "op":
        found = _op(c, name)
        return None if found is None else yaml.safe_dump(_norm(_op_view(*found)), sort_keys=True)
    if kind in ("event", "job"):
        for n, lines in _sections(c.files.get("events.md", "")):
            if n == name:
                return "\n".join(lines).rstrip()
        return None
    fname = c.types.get(kind)
    d = _load(c.files.get(fname)) if fname else None
    if d is None or name not in {str(k) for k in d}:
        return None
    return yaml.safe_dump(_norm({k: v for k, v in d.items() if str(k) == name}), sort_keys=True)


def extract(c: Contracts, cited: set[tuple[str, str]]) -> dict[str, str]:
    """Snapshot file name -> body (no header) holding exactly the cited items."""
    have = items(c)
    missing = sorted((k, n) for k, n in cited if (n.lower() if k == "table" else n) not in have.get(k, set()))
    if missing:
        raise Missing(missing)
    out: dict[str, str] = {}
    tables = {n.lower() for k, n in cited if k == "table"}
    if tables:
        body = []
        for chunk, stmt in _chunks(c):
            if (isinstance(stmt, exp.Create) and (stmt.args.get("kind") or "").upper() == "TABLE"
                    and stmt.find(exp.Table) is not None and stmt.find(exp.Table).name.lower() in tables) \
                    or _comment_table(stmt) in tables:
                body.append(chunk)
        out["schema.sql"] = "\n".join(body) + "\n"
    ops = sorted(n for k, n in cited if k == "op")
    if ops:
        data = _load(c.files["openapi.yaml"])
        doc: dict = {k: data[k] for k in ("openapi", "info", "servers") if k in data}
        comps: dict[str, dict] = {}
        for name in ops:
            _, section, path, method, op = _op(c, name)
            view = _op_view(data, section, path, method, op)
            slot = doc.setdefault(section, {}).setdefault(path, {})
            if data[section][path].get("parameters"):
                slot["parameters"] = data[section][path]["parameters"]
            slot[method] = op
            for sec, entries in view["components"].items():
                comps.setdefault(sec, {}).update(entries)
        for path, item in [(p, i) for s in ("paths", "webhooks") for p, i in doc.get(s, {}).items()]:
            doc_item = {k: item[k] for k in ("parameters", *_METHODS) if k in item}
            item.clear()
            item.update(doc_item)
        if comps:
            doc["components"] = comps
        out["openapi.yaml"] = yaml.safe_dump(doc, sort_keys=False)
    names = {n for k, n in cited if k in ("event", "job")}
    if names:
        keep = ["\n".join(ls).rstrip() for n, ls in _sections(c.files["events.md"]) if n in names]
        out["events.md"] = "\n\n".join(keep) + "\n"
    for kind, fname in c.types.items():
        want = {n for k, n in cited if k == kind}
        if want:
            d = _load(c.files[fname])
            out[fname] = yaml.safe_dump({k: v for k, v in d.items() if str(k) in want}, sort_keys=False)
    return out


def header(name: str, prd: str, version: str, commit: str, kind: str | None = None, dialect: str | None = None) -> str:
    """The snapshot header line, in the comment syntax of the file `name`."""
    text = f"Snapshot of {prd} {version} at {commit}, written by prd_links.py sync. Do not edit."
    if kind:
        text += f" Type: {kind}."
    if dialect:
        text += f" Dialect: {dialect}."
    if name.endswith(".sql"):
        return f"-- {text}"
    if name.endswith(".md"):
        return f"<!-- {text} -->"
    return f"# {text}"
