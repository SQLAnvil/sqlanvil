"""Contract rules (contracts-valid, schema-refs, error-codes) and the contract lookups other rules share."""
import glob
import os
import re
import shlex
import subprocess
from collections.abc import Iterator

from ..deps import require
from ..findings import Finding
from ..markdown import strip_code, tables
from ..model import UPSTREAM_DIR, Prd
from ..registry import rule
from .ids import defined_ids
from .structure import prose

sqlglot = require("sqlglot", "sqlglot")
from sqlglot import exp  # noqa: E402

osv = require("openapi_spec_validator", "openapi-spec-validator")

PACK_VALIDATOR = "pack"  # a section-7 Validator cell naming the validator of the pack that declares the type
_EVENT_HEADING = re.compile(r"^###\s+`?([^`\s]+)`?\s*$")
_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


def parse_schema(text: str, dialect: str | None):
    """The statements of a schema.sql text; None when it does not parse (or the dialect is unknown)."""
    try:
        return sqlglot.parse(text, read=dialect or None)
    except Exception:  # sqlglot raises ParseError, TokenError or ValueError (unknown dialect)
        return None


def create_tables(statements) -> Iterator[tuple[str, "exp.Create"]]:
    """(table name, statement) for each CREATE TABLE of parsed statements."""
    for stmt in statements:
        if isinstance(stmt, exp.Create) and (stmt.args.get("kind") or "").upper() == "TABLE":
            table = stmt.find(exp.Table)
            if table is not None:
                yield table.name, stmt


def schema_tables(prd: Prd) -> dict[str, set[str]]:
    """Table name -> column names from contracts/schema.sql; {} when it is absent or does not parse."""
    path = prd.root / "contracts/schema.sql"
    if not path.is_file():
        return {}
    statements = parse_schema(path.read_text(encoding="utf-8"), prd.frontmatter.get("sql-dialect") or None)
    tables: dict[str, set[str]] = {}
    for name, stmt in create_tables(statements or []):
        tables.setdefault(name, set()).update(c.name for c in stmt.find_all(exp.ColumnDef))
    return tables


def operations_of(data) -> Iterator[tuple[str, str, str, str, dict]]:
    """(operationId, section, path, method, operation) for each operation of an OpenAPI mapping."""
    if not isinstance(data, dict):
        return
    for section in ("paths", "webhooks"):
        items = data.get(section)
        for path, item in items.items() if isinstance(items, dict) else []:
            if not isinstance(item, dict):
                continue
            for method in _METHODS:
                op = item.get(method)
                if isinstance(op, dict) and isinstance(op.get("operationId"), str):
                    yield op["operationId"], section, str(path), method, op


def operation_ids(prd: Prd) -> set[str]:
    """Every operationId in contracts/openapi.yaml (paths and webhooks)."""
    return {oid for oid, *_ in operations_of(prd.yaml.get("contracts/openapi.yaml"))}


def event_names(prd: Prd) -> set[str]:
    """`### name` headings of contracts/events.md plus asyncapi channels and operations."""
    out: set[str] = set()
    for line in prd.docs.get("contracts/events.md", "").split("\n"):
        m = _EVENT_HEADING.match(line)
        if m:
            out.add(m.group(1))
    data = prd.yaml.get("contracts/asyncapi.yaml")
    if isinstance(data, dict):
        channels = data.get("channels")
        for name, channel in channels.items() if isinstance(channels, dict) else []:
            out.add(str(name))
            if isinstance(channel, dict):
                if isinstance(channel.get("address"), str):
                    out.add(channel["address"])
                for verb in ("publish", "subscribe"):  # AsyncAPI 2.x operations live under the channel
                    op = channel.get(verb)
                    if isinstance(op, dict) and isinstance(op.get("operationId"), str):
                        out.add(op["operationId"])
        ops = data.get("operations")
        out.update(str(k) for k in (ops if isinstance(ops, dict) else {}))  # AsyncAPI 3.x
    return out


# ---------------------------------------------------------------- contracts-valid

_CODE = re.compile(r"[A-Z][A-Z0-9_]*")
_ERROR_FIELDS = ("meaning", "when", "status", "message", "log_level", "retryable", "metric")
_EVENT_FIELDS = ("Trigger", "Payload", "Delivery", "Retries", "Failure")
_KINDS = {"public", "internal", "confidential", "pii"}
_FAILURE_KEYS = ("timeout", "4xx", "5xx", "outage")
_DEP_KEYS = ("sends", "expects", "auth", "limits", "mock", "failures")
_ID_TOKEN = re.compile(r"^(?:UJ-\d+|FR-\d+|NFR-\d+|AC-\d+\.\d+)$")


def _kl(node, key, default: int = 1) -> int:
    """Line of `key` in a loaded mapping, else the mapping's own line, else `default`."""
    lines = getattr(node, "key_lines", None) or {}
    return lines.get(key) or getattr(node, "line", 0) or default


def _plain(node):
    """Deep copy as plain dict/list, so third-party validators see ordinary types."""
    if isinstance(node, dict):
        return {k: _plain(v) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [_plain(v) for v in node]
    return node


def _map(node, key):
    v = node.get(key) if isinstance(node, dict) else None
    return v if isinstance(v, dict) else None


def _check_openapi(prd: Prd, rel: str, data: dict) -> Iterator[Finding]:
    def bad(line, msg):
        return Finding(rel, line, "contracts-valid", msg)

    try:
        osv.validate(_plain(data))
    except Exception as e:  # validator raises many error types
        first = (str(e).strip().splitlines() or [type(e).__name__])[0]
        yield bad(1, f"openapi validation failed: {first}")
    ids = set(defined_ids(prd))
    for section in ("paths", "webhooks"):
        items = data.get(section)
        if items is None:
            continue
        if not isinstance(items, dict):
            yield bad(_kl(data, section), f"{section} must be a mapping")
            continue
        for path, item in items.items():
            if not isinstance(item, dict):
                yield bad(_kl(items, path), f"{path}: must be a mapping")
                continue
            for method in _METHODS:
                op = item.get(method)
                if op is None:
                    continue
                where = f"{method.upper()} {path}"
                if not isinstance(op, dict):
                    yield bad(_kl(item, method), f"{where}: operation must be a mapping")
                    continue
                oline = _kl(item, method)
                if not isinstance(op.get("operationId"), str) or not op["operationId"]:
                    yield bad(oline, f"{where}: missing operationId")
                prd_ids = op.get("x-prd-ids")
                if not isinstance(prd_ids, list) or not prd_ids:
                    yield bad(_kl(op, "x-prd-ids", oline), f"{where}: x-prd-ids must be a non-empty list")
                else:
                    for i in prd_ids:
                        if not isinstance(i, str) or not _ID_TOKEN.match(i) or i not in ids:
                            yield bad(_kl(op, "x-prd-ids", oline), f"{where}: x-prd-ids item {i!r} is not a defined requirement or AC id")
                for key in ("x-error-codes", "x-preconditions", "x-effects"):
                    if not isinstance(op.get(key), list):
                        yield bad(_kl(op, key, oline), f"{where}: {key} must be a list (use [] for none)")
                resp = op.get("responses")
                if not isinstance(resp, dict):
                    yield bad(_kl(op, "responses", oline), f"{where}: responses must be a mapping")
                    continue
                for status, r in resp.items():
                    if str(status) == "204":
                        continue
                    rline = _kl(resp, status, oline)
                    if not isinstance(r, dict):
                        yield bad(rline, f"{where}: response {status} must be a mapping")
                    elif "$ref" in r:
                        continue
                    elif not _has_example(r.get("content")):
                        yield bad(rline, f"{where}: response {status} has no content example")


def _has_example(content) -> bool:
    if not isinstance(content, dict):
        return False
    return any(isinstance(m, dict) and ("example" in m or "examples" in m) for m in content.values())


def _check_events(rel: str, text: str) -> Iterator[Finding]:
    lines = text.split("\n")
    stripped = strip_code(text).split("\n")
    heading = None
    seen: set[str] = set()

    def close():
        if heading:
            for f in _EVENT_FIELDS:
                if f not in seen:
                    yield Finding(rel, heading[1], "contracts-valid", f"event '{heading[0]}' has no {f}: line")

    for n, (orig, st) in enumerate(zip(lines, stripped), 1):
        if re.match(r"^#{1,3}\s", st):
            yield from close()
            m = re.match(r"^###\s+(.*?)\s*$", st)
            heading, seen = ((orig[4:].strip().strip("`"), n) if m else None), set()
            continue
        for f in _EVENT_FIELDS:
            if heading and orig.startswith(f + ":"):
                seen.add(f)
    yield from close()


def _described(stmt) -> bool:
    return any(isinstance(p.this, exp.Var) and p.name.lower() == "description" for p in stmt.find_all(exp.Property))


def _check_schema(prd: Prd, rel: str, text: str) -> Iterator[Finding]:
    dialect = prd.frontmatter.get("sql-dialect") or None
    try:
        statements = sqlglot.parse(text, read=dialect)
    except Exception as e:
        first = (str(e).strip().splitlines() or [type(e).__name__])[0]
        yield Finding(rel, 1, "contracts-valid", f"schema.sql does not parse ({dialect or 'default dialect'}): {first}")
        return
    commented_tables: set[str] = set()
    commented_columns: set[tuple[str, str]] = set()
    for stmt in statements:
        if isinstance(stmt, exp.Comment):
            target = stmt.this
            if isinstance(target, exp.Table):
                commented_tables.add(target.name)
            elif isinstance(target, exp.Column):
                commented_columns.add((target.table, target.name))
    for stmt in statements:
        if not (isinstance(stmt, exp.Create) and (stmt.args.get("kind") or "").upper() == "TABLE"):
            continue
        table = stmt.find(exp.Table)
        if table is None:
            continue
        name = table.name
        line = _stmt_line(text, name)
        props = stmt.args.get("properties")
        if name not in commented_tables and not (props is not None and _described(props)):
            yield Finding(rel, line, "contracts-valid", f"table {name} has no COMMENT ON TABLE or OPTIONS(description=...)")
        for col in stmt.find_all(exp.ColumnDef):
            if (name, col.name) not in commented_columns and not _described(col):
                yield Finding(rel, _stmt_line(text, col.name, line), "contracts-valid", f"column {name}.{col.name} has no COMMENT ON COLUMN or OPTIONS(description=...)")


def _stmt_line(text: str, name: str, start: int = 1) -> int:
    """Best-effort line of the first word `name` at or after line `start`."""
    for n, line in enumerate(text.split("\n"), 1):
        if n >= start and re.search(rf"\b{re.escape(name)}\b", line):
            return n
    return start


def _check_errors(rel: str, data: dict) -> Iterator[Finding]:
    for code, spec in data.items():
        line = _kl(data, code)
        if not isinstance(code, str) or not _CODE.fullmatch(code):
            yield Finding(rel, line, "contracts-valid", f"error code {code!r} must match ^[A-Z][A-Z0-9_]*$")
        if not isinstance(spec, dict):
            yield Finding(rel, line, "contracts-valid", f"{code}: must be a mapping with {', '.join(_ERROR_FIELDS)}")
            continue
        for f in _ERROR_FIELDS:
            if f not in spec:
                yield Finding(rel, line, "contracts-valid", f"{code}: missing {f}")
        st = spec.get("status")
        if "status" in spec and (not isinstance(st, int) or isinstance(st, bool)):
            yield Finding(rel, _kl(spec, "status", line), "contracts-valid", f"{code}: status must be an integer")
        if "retryable" in spec and not isinstance(spec["retryable"], bool):
            yield Finding(rel, _kl(spec, "retryable", line), "contracts-valid", f"{code}: retryable must be true or false")


def _check_permissions(rel: str, data: dict) -> Iterator[Finding]:
    def bad(line, msg):
        return Finding(rel, line, "contracts-valid", msg)

    roles = data.get("roles")
    if not isinstance(roles, dict):
        yield bad(_kl(data, "roles"), "roles must be a mapping of role to {identity}")
        roles = {}
    for r, spec in roles.items():
        if not isinstance(spec, dict) or not spec.get("identity"):
            yield bad(_kl(roles, r), f"role {r}: missing identity")
    ops = data.get("operations")
    if not isinstance(ops, dict):
        yield bad(_kl(data, "operations"), "operations must be a mapping of operation to {allow, deny}")
        ops = {}
    for op, cell in ops.items():
        line = _kl(ops, op)
        if not isinstance(cell, dict):
            yield bad(line, f"operation {op}: must be a mapping with allow and deny lists")
            continue
        lists: dict[str, list] = {}
        for k in ("allow", "deny"):
            if not isinstance(cell.get(k), list):
                yield bad(_kl(cell, k, line), f"operation {op}: {k} must be a list")
            else:
                lists[k] = cell[k]
        if len(lists) == 2:
            for r in roles:
                n = (r in lists["allow"]) + (r in lists["deny"])
                if n != 1:
                    yield bad(line, f"operation {op}: role {r} must appear in exactly one of allow and deny (found {n})")
            for r in lists["allow"] + lists["deny"]:
                if isinstance(r, str) and r not in roles:
                    yield bad(line, f"operation {op}: unknown role {r}")
    rr = data.get("row_rules")
    if rr is None:
        return
    if not isinstance(rr, list):
        yield bad(_kl(data, "row_rules"), "row_rules must be a list")
        return
    for i, rule_ in enumerate(rr, 1):
        line = getattr(rule_, "line", 0) or _kl(data, "row_rules")
        if not isinstance(rule_, dict):
            yield bad(line, f"row_rules item {i} must be a mapping")
            continue
        for f in ("role", "operation", "predicate", "attribute"):
            if not rule_.get(f):
                yield bad(line, f"row_rules item {i}: missing {f}")


def _check_config(rel: str, data: dict) -> Iterator[Finding]:
    settings = data.get("settings")
    if not isinstance(settings, dict):
        yield Finding(rel, _kl(data, "settings"), "contracts-valid", "settings must be a mapping of name to {type, default, environments, owner}")
        return
    for name, spec in settings.items():
        line = _kl(settings, name)
        if not isinstance(spec, dict):
            yield Finding(rel, line, "contracts-valid", f"setting {name}: must be a mapping")
            continue
        for f in ("type", "default", "environments", "owner"):
            if f not in spec:
                yield Finding(rel, line, "contracts-valid", f"setting {name}: missing {f}")
        if "environments" in spec and not isinstance(spec["environments"], dict):
            yield Finding(rel, _kl(spec, "environments", line), "contracts-valid", f"setting {name}: environments must be a mapping")


def _check_classification(rel: str, data: dict) -> Iterator[Finding]:
    tbls = data.get("tables")
    if not isinstance(tbls, dict):
        yield Finding(rel, _kl(data, "tables"), "contracts-valid", "tables must be a mapping")
        tbls = {}
    for t, spec in tbls.items():
        line = _kl(tbls, t)
        if not isinstance(spec, dict):
            yield Finding(rel, line, "contracts-valid", f"table {t}: must be a mapping")
            continue
        for f in ("retention", "deletion", "columns"):
            if f not in spec:
                yield Finding(rel, line, "contracts-valid", f"table {t}: missing {f}")
        cols = spec.get("columns")
        if "columns" in spec and not isinstance(cols, dict):
            yield Finding(rel, _kl(spec, "columns", line), "contracts-valid", f"table {t}: columns must be a mapping of column to class")
        elif isinstance(cols, dict):
            for c, kind in cols.items():
                if kind not in _KINDS:
                    yield Finding(rel, _kl(cols, c, line), "contracts-valid", f"{t}.{c}: class {kind!r} must be public, internal, confidential or pii")
    masking = data.get("masking")
    if not isinstance(masking, dict):
        yield Finding(rel, _kl(data, "masking"), "contracts-valid", "masking must be a mapping with logs, errors and fixtures")
        return
    for f in ("logs", "errors", "fixtures"):
        if f not in masking:
            yield Finding(rel, _kl(masking, f), "contracts-valid", f"masking: missing {f}")


def _check_dependency(rel: str, data: dict) -> Iterator[Finding]:
    for k in _DEP_KEYS:
        if k not in data:
            yield Finding(rel, _kl(data, k), "contracts-valid", f"missing {k}")
    auth = data.get("auth")
    if "auth" in data and not (isinstance(auth, dict) and auth.get("secret")):
        yield Finding(rel, _kl(data, "auth"), "contracts-valid", "auth must be a mapping with secret")
    fails = data.get("failures")
    if "failures" in data:
        if not isinstance(fails, dict):
            yield Finding(rel, _kl(data, "failures"), "contracts-valid", "failures must be a mapping with timeout, 4xx, 5xx and outage")
        else:
            for k in _FAILURE_KEYS:
                if k not in fails:
                    yield Finding(rel, _kl(fails, "failures"), "contracts-valid", f"failures: missing {k}")


def pack_list(prd: Prd) -> list:
    """The resolved packs a `pack` row or a pack target kind looks in: each named pack that resolves, in named order,
    then `service`. Resolved once per loaded PRD."""
    cached = getattr(prd, "_pack_list", None)
    if cached is None:
        from .. import packs  # local: packs imports the rules package

        cached = []
        for ref in [*packs.named(prd), packs.SERVICE_DEFAULT]:
            try:
                pack = packs.resolve_cached(prd, ref)
            except (packs.ManifestError, packs.PackNotFound, packs.PackMismatch, OSError, ValueError):
                continue
            if all(pack.name != c.name for c in cached):
                cached.append(pack)
        prd._pack_list = cached
    return cached


def pack_validator(prd: Prd, kind: str) -> str | None:
    """The command of the first pack (named order, then service) that declares contract type `kind` with a validator
    other than built-in, its `${PACK}` expanded and quoted so shlex.split gives it back; None when none does."""
    from .. import packs

    for pack in pack_list(prd):
        for ct in pack.contract_types:
            if ct["type"] == kind and ct["validator"] != "built-in":
                return shlex.join(packs.expand(ct["validator"], pack))
    return None


def pack_kinds(prd: Prd) -> dict[str, str]:
    """Each target kind a resolved pack declares -> the contract type its names resolve in."""
    out: dict[str, str] = {}
    for pack in pack_list(prd):
        for kind, ctype in pack.target_kinds.items():
            out.setdefault(kind, ctype)
    return out


def custom_types(prd: Prd) -> Iterator[tuple[str, str, list[str], int]]:
    """(type, validator command, matching files, row line) for each section-7 row with a validator other than built-in.
    A `pack` row yields the command of the pack that declares its type, or `pack` itself when none does."""
    sec = next((s for s in prd.sections if s.number == 7), None)
    for t in tables(sec.body) if sec else []:
        for r in t.rows:
            if len(r.cells) < 3:
                continue
            validator = r.cells[2].strip().strip("`").strip()
            if not validator or validator == "built-in":
                continue
            kind = r.cells[0].strip("`").strip()
            if validator == PACK_VALIDATOR:
                validator = pack_validator(prd, kind) or PACK_VALIDATOR
            globs = [g for g in re.split(r"[,\s]+", r.cells[1].replace("`", "")) if g]
            files = sorted({f for g in globs for f in glob.glob(g, root_dir=prd.root, recursive=True) if (prd.root / f).is_file() and not (prd.links is not None and f.startswith(UPSTREAM_DIR + "/"))})
            yield kind, validator, files, r.line


_custom_types = custom_types


def custom_items(prd: Prd) -> dict[str, set[str]]:
    """Each custom type name -> the top-level keys of its YAML files. A type none of whose files is a
    YAML mapping is absent, so its `<type>:<name>` targets cannot be checked."""
    out: dict[str, set[str]] = {}
    for kind, _, files, _ in custom_types(prd):
        for f in files:
            data = prd.yaml.get(f)
            if isinstance(data, dict):
                out.setdefault(kind, set()).update(str(k) for k in data)
    for kind, ctype in pack_kinds(prd).items():
        if ctype in out:
            out[kind] = out[ctype]
    return out


def _validator_timeout() -> int:
    try:
        return int(os.environ.get("PRD_VALIDATOR_TIMEOUT", "120"))
    except ValueError:
        return 120


def _check_custom(prd: Prd) -> Iterator[Finding]:
    timeout = _validator_timeout()
    for kind, validator, files, line in custom_types(prd):
        def bad(msg):
            return Finding("prd.md", line, "contracts-valid", f"custom type {kind}: {msg}")

        if validator == PACK_VALIDATOR:
            yield bad(f"no named pack declares contract type {kind}")
            continue
        if not files:
            yield bad("glob matches no file")
            continue

        try:
            argv = shlex.split(validator)
        except ValueError as e:
            yield bad(f"validator does not parse: {e}")
            continue
        if not argv:
            continue
        try:
            done = subprocess.run(argv + files, cwd=prd.root, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=timeout)
        except FileNotFoundError:
            yield bad(f"validator not found: {argv[0]}")
        except PermissionError:
            yield bad(f"validator not executable: {argv[0]}")
        except subprocess.TimeoutExpired:
            yield bad(f"validator timed out after {timeout}s")
        else:
            if done.returncode != 0:
                # the first non-blank stderr line, else the first non-blank stdout line, else the exit
                lines = done.stderr.splitlines() + done.stdout.splitlines()
                first = next((x for x in lines if x.strip()), f"exit {done.returncode}")
                yield bad(f"validator failed: {first}")


@rule("contracts-valid", description="Checks each contract file against its shape: YAML that parses with no repeated key, OpenAPI operations whose x-prd-ids name defined requirement or AC IDs, the asyncapi key of asyncapi.yaml, errors.yaml codes, permissions, config settings, data classification, dependencies, events.md sections, schema.sql that parses in the sql-dialect with a comment on every table and column, and each section 7 custom or pack type, whose glob must match a file and whose validator must run and pass. Fix the file to the shape in prd-format.md's Contract YAML shapes; for a custom type, correct its section 7 Files glob or Validator command, name the pack that declares it, or fix the files its validator rejects.")
def contracts_valid(prd: Prd):
    # parse errors, duplicate keys and non-mapping top levels are reported by the loader
    for rel, data in prd.yaml.items():
        if not isinstance(data, dict):
            continue
        name = rel.rsplit("/", 1)[-1]
        if rel == "contracts/openapi.yaml":
            yield from _check_openapi(prd, rel, data)
        elif rel == "contracts/asyncapi.yaml":
            if "asyncapi" not in data:
                yield Finding(rel, 1, "contracts-valid", "missing top-level key asyncapi")
        elif rel == "contracts/errors.yaml":
            yield from _check_errors(rel, data)
        elif rel == "contracts/permissions.yaml":
            yield from _check_permissions(rel, data)
        elif rel == "contracts/config.yaml":
            yield from _check_config(rel, data)
        elif rel == "contracts/data-classification.yaml":
            yield from _check_classification(rel, data)
        elif rel.startswith("contracts/dependencies/") and rel.count("/") == 2 and name.endswith(".yaml"):
            yield from _check_dependency(rel, data)
    if "contracts/events.md" in prd.docs:
        yield from _check_events("contracts/events.md", prd.docs["contracts/events.md"])
    schema = prd.root / "contracts/schema.sql"
    if schema.is_file():
        yield from _check_schema(prd, "contracts/schema.sql", schema.read_text(encoding="utf-8"))
    yield from _check_custom(prd)


# ---------------------------------------------------------------- schema-refs

_FENCE = re.compile(r"^\s*(```|~~~)")
_SPAN = re.compile(r"(`+)(.+?)\1")
_FILE_EXTENSIONS = {"csv", "tsv", "sql", "yaml", "yml", "json", "md", "txt", "lkml"}
_QUALIFIED = re.compile(r"([A-Za-z_]\w*)\.([A-Za-z_]\w*)")


@rule("schema-refs", description="Checks that a backticked table.column in prose names a column the table in contracts/schema.sql has. Correct the column name, or add the column to the schema.")
def schema_refs(prd: Prd):
    tables_ = schema_tables(prd)
    if not tables_:
        return
    fenced: dict[str, set[int]] = {}
    for rel, text in prd.docs.items():
        on, lines = False, set()
        for n, line in enumerate(text.split("\n"), 1):
            if _FENCE.match(line):
                on = not on
                lines.add(n)
            elif on:
                lines.add(n)
        fenced[rel] = lines
    originals = {rel: text.split("\n") for rel, text in prd.docs.items()}
    for rel, n, _ in prose(prd):
        # errors.md quotes what went wrong: a diagnosis naturally names the column the code got wrong
        if rel == "errors.md" or n in fenced[rel]:
            continue
        for m in _SPAN.finditer(originals[rel][n - 1]):
            q = _QUALIFIED.fullmatch(m.group(2).strip())
            if q and q.group(2) not in _FILE_EXTENSIONS and q.group(1) in tables_ and q.group(2) not in tables_[q.group(1)]:
                yield Finding(rel, n, "schema-refs", f"`{q.group(0)}`: table {q.group(1)} has no column {q.group(2)}")


# ---------------------------------------------------------------- error-codes


def _strs(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def error_citations(prd: Prd) -> list[tuple[str, str, int]]:
    """(code, file, line) for every code cited by a block Errors: line, an openapi x-error-codes list or a
    dependency failures entry. Test-case expect.errors is not included."""
    out: list[tuple[str, str, int]] = [(code, b.file, line) for b in prd.blocks for code, line in b.errors]
    for section in ("paths", "webhooks"):
        items = _map(prd.yaml.get("contracts/openapi.yaml"), section) or {}
        for item in items.values():
            for method in _METHODS:
                op = item.get(method) if isinstance(item, dict) else None
                if isinstance(op, dict):
                    out += [(c, "contracts/openapi.yaml", _kl(op, "x-error-codes")) for c in _strs(op.get("x-error-codes"))]
    for rel, data in prd.yaml.items():
        fails = _map(data, "failures") if rel.startswith("contracts/dependencies/") else None
        for key, value in (fails or {}).items():
            out += [(c, rel, _kl(fails, key)) for c in _strs(value)]
    return out


def _test_case_codes(prd: Prd) -> set[str]:
    codes: set[str] = set()
    for tc in prd.test_cases:
        expect = tc.data.get("expect")
        if isinstance(expect, dict):
            codes.update(_strs(expect.get("errors")))
    return codes


@rule("error-codes", description="Checks that every error code a block's Errors: line, an OpenAPI x-error-codes list or a dependency's failures cite is in contracts/errors.yaml, and that every catalogued code is cited somewhere, a test case's expect.errors included. Add the code to the catalogue, or cite or delete the unused one.")
def error_codes(prd: Prd):
    catalogue = prd.yaml.get("contracts/errors.yaml")
    if not isinstance(catalogue, dict):
        return  # a missing or unreadable catalogue is reported elsewhere
    cited = error_citations(prd)
    for code, file, line in cited:
        if code not in catalogue:
            yield Finding(file, line, "error-codes", f"error code {code} is not in contracts/errors.yaml")
    used = {c for c, _, _ in cited} | _test_case_codes(prd)
    for code in catalogue:
        if code not in used:
            yield Finding("contracts/errors.yaml", _kl(catalogue, code), "error-codes", f"error code {code} is catalogued but cited nowhere")
