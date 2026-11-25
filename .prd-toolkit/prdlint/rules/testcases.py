"""Test-case rules: every test is fully specified by the PRD alone (spec 4.1, 4.2)."""
import csv
import fnmatch
import io
import json
import math
import re
import shlex
from collections.abc import Iterator
from fractions import Fraction

from ..findings import Finding
from .. import model
from ..markdown import strip_code, tables
from ..model import Prd, TestCase
from ..registry import rule
from ..yamlload import yaml
from .contracts import custom_items, custom_types, event_names, operation_ids, pack_kinds, schema_tables

TARGET_KINDS = {"op", "table", "event", "job", "component", "page", "code"}

_HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*$")


def _headings(text: str) -> list[str]:
    """Each heading's text as written, code spans included: a line is a heading only outside
    fenced code blocks, which strip_code blanks, and its text comes from the original line."""
    out: list[str] = []
    for orig, stripped in zip(text.split("\n"), strip_code(text).split("\n")):
        if _HEADING.match(stripped):
            out.append(_HEADING.match(orig).group(1))
    return out


def _ref_problem(prd: Prd, ref: object) -> str | None:
    """Why a `refs:` entry does not resolve, or None. An entry is a PRD-folder path, optionally
    followed by '#' and the exact text of a heading in that file."""
    if not isinstance(ref, str) or not ref.strip():
        return f"refs entry {ref!r} must be a path in the PRD folder, optionally with #heading"
    path, _, heading = ref.partition("#")
    target = (prd.root / path).resolve()
    if not target.is_relative_to(prd.root) or not target.is_file():
        return f"refs entry '{ref}': no file {path} in the PRD folder"
    if heading:
        if heading not in _headings(target.read_text(encoding="utf-8")):
            return f"refs entry '{ref}': {path} has no heading '{heading}'"
    return None

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
_PHONE = re.compile(r"(?<!\d)\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?!\d)")  # not inside a longer digit run
_SSN = re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")
_SYNTHETIC_DOMAINS = {"example.com", "example.org", "example.net"}
_SYNTHETIC_SUFFIXES = (".example.com", ".example.org", ".example.net", ".test", ".example", ".invalid")
_AC_NUMBER = re.compile(r"AC-(\d+)\.\d+")
_TID_NUMBER = re.compile(r"T-(\d+)\.\d+")


# ---------------------------------------------------------------- PII helpers (public)


def pii_values(text: str) -> list[str]:
    """Every email, SSN and phone-number-shaped value in `text`, synthetic or not."""
    out: list[str] = []
    for pattern in (_EMAIL, _SSN, _PHONE):  # most specific first; a match is blanked before the next pattern
        for m in pattern.finditer(text):
            out.append(m.group(0))
        text = pattern.sub(lambda m: " " * len(m.group(0)), text)
    return out


def is_synthetic(value: str) -> bool:
    """True when `value` is an allowed synthetic PII form. A value that is not PII-shaped counts as synthetic."""
    if _EMAIL.fullmatch(value):
        domain = value.rsplit("@", 1)[1].lower()
        return domain in _SYNTHETIC_DOMAINS or domain.endswith(_SYNTHETIC_SUFFIXES)
    if _SSN.fullmatch(value):
        area = value[:3]
        return area in ("000", "666") or area.startswith("9")
    if _PHONE.fullmatch(value):
        digits = re.sub(r"\D", "", value)
        return digits[3:6] == "555" and digits[6:8] == "01"  # line 0100 to 0199
    return True


# ---------------------------------------------------------------- shared helpers


def target_kinds(prd: Prd) -> set[str]:
    """Built-in target kinds, the custom type names of prd.md section 7 (validator not `built-in`) and the target kinds
    of the packs the PRD names."""
    kinds = set(TARGET_KINDS) | set(pack_kinds(prd))
    sec = next((s for s in prd.sections if s.number == 7), None)
    for t in tables(sec.body) if sec else []:
        for r in t.rows:
            if len(r.cells) >= 3 and r.cells[2].strip("`").strip() != "built-in":
                kinds.add(r.cells[0].strip("`").strip())
    return kinds


def _cases(prd: Prd) -> Iterator[TestCase]:
    """Test cases that are mappings; the loader already reports the others under `sufficiency`."""
    bad = {(f.file, f.line) for f in prd.load_findings if f.rule == "sufficiency" and "must be a mapping" in f.message}
    for tc in prd.test_cases:
        if (tc.file, tc.line) not in bad:
            yield tc


def _line(tc: TestCase, key: str) -> int:
    return tc.data.key_lines.get(key, tc.line)


def _expect(tc: TestCase) -> dict:
    e = tc.data.get("expect")
    return e if isinstance(e, dict) else {}


def is_judged(tc: TestCase) -> bool:
    """A judged case: `expect` is a mapping holding `rubric` (a model grader scores it)."""
    e = tc.data.get("expect")
    return isinstance(e, dict) and "rubric" in e


def _blank(v) -> bool:
    return v is None or (isinstance(v, (str, list, dict)) and len(v) == 0)


def _exists_fixture(prd: Prd, name: str) -> bool:
    base = prd.root / "contracts/fixtures" / name
    return base.is_dir() or (base.parent.is_dir() and any(p.is_file() and p.stem == base.name for p in base.parent.iterdir()))



# ---------------------------------------------------------------- rules


@rule("ac-has-test", description="Checks that every live acceptance criterion of a requirement that is not removed has at least one test case whose ac: names it. Add a case to the area's test-cases file with ac: set to that AC.")
def ac_has_test(prd: Prd):
    covered = {str(tc.data.get("ac")) for tc in _cases(prd)}
    for b in prd.blocks:
        if b.status == "removed":
            continue
        for ac in b.acs:
            if not ac.removed and ac.id not in covered:
                yield Finding(b.file, ac.line, "ac-has-test", f"{ac.id} has no test case whose ac: is {ac.id}")


@rule("test-cases-consistent", description="Checks that each block's Tests line names its test-cases file, that the file exists and holds an entry for every T-id listed, at the level the line gives, and that every test case is cited by a Tests line naming its file. End the Tests line with (test-cases/<area>.yaml) for a file that exists, add the missing entry or Tests item, or make the level on the line and in the case agree.")
def test_cases_consistent(prd: Prd):
    entries = {(tc.file, tc.id): tc for tc in prd.test_cases}
    cited: set[tuple[str | None, str]] = set()
    for b in prd.blocks:
        if b.tests and b.tests_file is None:  # once for the line, and none of its T-ids is cited
            yield Finding(b.file, b.tests[0][2], "test-cases-consistent", f"the Tests line of {b.id} names no test-cases file; end it with (test-cases/<area>.yaml)")
            continue
        for tid, level, line in b.tests:
            cited.add((b.tests_file, tid))
            if not (prd.root / b.tests_file).is_file():
                yield Finding(b.file, line, "test-cases-consistent", f"{tid}: the named file {b.tests_file} does not exist")
                continue
            tc = entries.get((b.tests_file, tid))
            if tc is None:
                yield Finding(b.file, line, "test-cases-consistent", f"{tid} has no entry in {b.tests_file}")
                continue
            actual = tc.data.get("level")
            if isinstance(actual, str) and actual != level:
                yield Finding(b.file, line, "test-cases-consistent", f"{tid} is [{level}] on the Tests line but level: {actual} in {tc.file}:{_line(tc, 'level')}")
    for tc in prd.test_cases:
        if (tc.file, tc.id) not in cited:
            yield Finding(tc.file, tc.line, "test-cases-consistent", f"{tc.id} is cited by no Tests line naming {tc.file}")


_SHELL_OPS = {"&&", "||", ";", "|", "&"}


def _norm(path: str) -> str:
    while path.startswith("./"):
        path = path[2:]
    return path.rstrip("/") or "."


# Runner options whose value is a separate token (pytest, jest, go test). The value is never the path.
_EXCLUDE_OPTS = {"--ignore", "--ignore-glob", "--deselect", "--testPathIgnorePatterns"}
_SELECT_OPTS = {"-m", "-k", "-t", "--testNamePattern", "-run"}
_VALUE_OPTS = _EXCLUDE_OPTS | _SELECT_OPTS | {
    "-p", "-c", "-o", "-n", "-W", "--rootdir", "--confcutdir", "--basetemp", "--junitxml", "--junit-xml",
    "--cov", "--cov-report", "--cov-config", "--log-file", "--maxfail", "--tb", "--durations",
    "--import-mode", "--override-ini", "--config", "--roots", "--selectProjects", "-tags", "-timeout",
}


class Harness:
    """What a Harness command collects: its first path, the paths it excludes, and whether a marker or
    keyword expression selects the tests (which the lint cannot evaluate)."""

    def __init__(self, path: str | None, excluded: list[str], selects: bool):
        self.path, self.excluded, self.selects = path, excluded, selects

    def excludes(self, path: str) -> bool:
        return any(path == e or path.startswith(e + "/") or fnmatch.fnmatchcase(path, e) for e in self.excluded)


def parse_harness(command: str, roots: set[str]) -> Harness:
    """Read a Harness command: a heuristic, never a shell parser.

    The path is the first argument that holds a `/` or is `.` or a test root's name. Program names (each
    simple command's first word, and the module after `python -m`), `VAR=value` prefixes, options, the
    value of a runner option that takes one, and files with an extension (a runner script like
    `tools/gate.sh`) are never paths. `--ignore` / `--ignore-glob` / `--deselect` values are exclusions;
    `-m` / `-k` and their kin select tests by an expression.
    """
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    path, excluded, selects = None, [], False
    want_program, program, pending = True, "", None
    for tok in tokens:
        if tok in _SHELL_OPS:
            want_program, pending = True, None
            continue
        if want_program:
            if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
                continue
            want_program, program = False, tok.rsplit("/", 1)[-1]
            continue
        if pending:  # the value of the option before it
            if pending in _EXCLUDE_OPTS:
                excluded.append(_norm(tok))
            elif pending in _SELECT_OPTS:
                selects = True
            pending = None
            continue
        if tok.startswith("-"):
            opt, eq, value = tok.partition("=")
            if program.startswith("python") and opt == "-m":
                want_program = True  # `python -m pytest`: the module is the runner
                continue
            if eq:
                if opt in _EXCLUDE_OPTS:
                    excluded.append(_norm(value))
                elif opt in _SELECT_OPTS:
                    selects = True
            elif opt in _VALUE_OPTS:
                pending = opt
            continue
        if path is None:
            name = _norm(tok)
            if name in (".", "..") or name in roots or ("/" in tok and "." not in name.rsplit("/", 1)[-1]):
                path = name
    return Harness(path, excluded, selects)


def harness_path(command: str, roots: set[str]) -> str | None:
    """The first path-like argument of a Harness command, normalized (see `parse_harness`)."""
    return parse_harness(command, roots).path


def _overlaps(prd: Prd):
    """(build level, deploy level, deploy path) where the build level's path is the deploy level's or a parent
    of it, the build command does not exclude that path, and no expression selects its tests."""
    t = prd.testing
    roots = {_norm(r) for r in t.harness.test_roots or []}
    parsed = {lvl: parse_harness(cmd, roots) for lvl, cmd in t.commands.items()}
    for b in t.levels:
        h = parsed.get(b)
        if t.gates.get(b) != "build" or not h or not h.path or h.selects:
            continue
        for d in t.levels:
            dp = parsed[d].path if d in parsed else None
            if t.gates.get(d) != "deploy" or not dp:
                continue
            bp = h.path
            if (bp == dp or bp == "." or dp.startswith(bp + "/")) and not h.excludes(dp):
                yield b, d, dp


@rule("test-level", description="Checks that testing.md's Levels table has a Gate column whose values are build or deploy, that no build-gate Harness command would collect a deploy-gate level's tests, and that each test case's level: is a row of that table. Add the level or the Gate value, or exclude the deploy-gate path from the build command with --ignore.")
def test_level(prd: Prd):
    t = prd.testing
    if "testing.md" in prd.docs and t.levels_line:
        if not t.has_gate:
            yield Finding("testing.md", t.levels_line, "test-level", model.GATE_MIGRATION)
        else:
            for lvl, g in t.gates.items():
                if g not in model.GATES:
                    yield Finding("testing.md", t.levels[lvl], "test-level", f"level '{lvl}': Gate '{g}' is not one of {', '.join(model.GATES)}")
            for b, d, path in _overlaps(prd):  # a build run, local or in CI, would run deploy-gate tests with no environment
                yield Finding("testing.md", t.levels[b], "test-level", f"level '{b}' (Gate build) would collect level '{d}' (Gate deploy) tests: {path}")
    for tc in _cases(prd):
        level = tc.data.get("level")
        if _blank(level):
            yield Finding(tc.file, tc.line, "test-level", f"{tc.id} has no level")
        elif str(level) not in prd.testing.levels:
            yield Finding(tc.file, _line(tc, "level"), "test-level", f"{tc.id}: level '{level}' is not a row of the Levels table in testing.md")


@rule("sufficiency", description="Checks that each test-cases file parses as YAML mapping each T-id to a mapping, and that each case has the eight sufficiency elements: ac, level, environment and identity as strings, target as <kind>:<name> of a known kind, preconditions as a list, a non-empty input, and expect with output (unless judged), effects and errors lists and leaks; an acceptance case also needs steps: and signoff:. Fix the YAML, or fill the element the message names in its form, with a target kind that is built in, a pack's, or a section 7 custom type. An entry named .md or .yaml in the PRD folder that is not a file is reported here too; rename or remove it.")
def sufficiency(prd: Prd):
    # parse errors, non-mapping files and non-mapping cases are reported by the loader
    kinds = target_kinds(prd)
    for tc in _cases(prd):
        d = tc.data

        def miss(key: str, what: str, line: int | None = None):
            return Finding(tc.file, line or _line(tc, key), "sufficiency", f"{tc.id}: {what}")

        for key in ("ac", "level", "environment", "identity"):
            if not isinstance(d.get(key), str) or not d[key].strip():
                yield miss(key, f"{key} is missing", tc.line)
        target = d.get("target")
        if not isinstance(target, str) or not target.strip():
            yield miss("target", "target is missing", tc.line)
        else:
            kind, sep, name = target.partition(":")
            if not sep or not name.strip():
                yield miss("target", f"target '{target}' must be <kind>:<name>")
            elif kind not in kinds and model.ref_prefix(prd, target) is None:  # upstream-refs judges a prefixed kind
                yield miss("target", f"target kind '{kind}' is unknown (known: {', '.join(sorted(kinds))})")
        if not isinstance(d.get("preconditions"), list):
            yield miss("preconditions", "preconditions must be a list (use [] for none)", tc.line if "preconditions" not in d else None)
        if _blank(d.get("input")):
            yield miss("input", "input is missing or empty", tc.line if "input" not in d else None)
        expect = d.get("expect")
        if not isinstance(expect, dict):
            yield miss("expect", "expect is missing", tc.line if "expect" not in d else None)
            expect = {}
        eline = _line(tc, "expect")
        if not is_judged(tc) and _blank(expect.get("output")):
            yield miss("expect", "expect.output is missing", expect.key_lines.get("output", eline) if hasattr(expect, "key_lines") else eline)
        for key in ("effects", "errors"):
            if not isinstance(expect.get(key), list):
                yield miss("expect", f"expect.{key} must be a list (use [] for none)", getattr(expect, "key_lines", {}).get(key, eline))
        if _blank(expect.get("leaks")):
            yield miss("expect", "expect.leaks is missing (use 'none')", getattr(expect, "key_lines", {}).get("leaks", eline))
        if d.get("level") == "acceptance":
            steps = d.get("steps")
            if not (isinstance(steps, list) and steps and all(isinstance(s, str) and s.strip() for s in steps)):
                yield miss("steps", "an acceptance case needs steps: a non-empty list of strings", tc.line if "steps" not in d else None)
            if not isinstance(d.get("signoff"), str) or not d["signoff"].strip():
                yield miss("signoff", "an acceptance case needs signoff: the business owner", tc.line if "signoff" not in d else None)


def _needs_every_item(threshold: float, n: int) -> str | None:
    """Why `threshold` demands all `n` rubric items although it is below 1.0, or None: the score is passed / n, so
    one miss scores (n-1)/n, and a threshold above that fails it (2 of 3 is 0.666..., below 0.67). The comparison
    is in floats, as prd_judge.py scores (`sum / len`, pass on `median >= threshold`): 4 of 5 passes 0.8."""
    miss = Fraction(n - 1, n)
    if not (threshold > (n - 1) / n and threshold < 1.0):
        return None
    down = Fraction(math.floor(miss * 100), 100)
    return (f"threshold {threshold:.4g} needs all {n} items ({n - 1} of {n} is {float(miss):.4g}); "
            f"write {float(down):.4g} to allow one miss, or 1.0")


@rule("judged-case", description="Checks a judged case's expect: rubric a non-empty list of distinct non-empty strings, threshold a number in (0, 1], runs an integer of at least 1, and no output beside rubric; it warns when a threshold below 1.0 still needs every rubric item. Fix the key the message names, or lower the threshold to allow one miss.")
def judged_case(prd: Prd):
    for tc in _cases(prd):
        if not is_judged(tc):
            continue
        e = tc.data["expect"]
        kl = getattr(e, "key_lines", {})
        eline = _line(tc, "expect")

        def bad(key: str, msg: str):
            return Finding(tc.file, kl.get(key, eline), "judged-case", f"{tc.id}: {msg}")

        r = e["rubric"]
        items_ok = isinstance(r, list) and r and all(isinstance(x, str) and x.strip() for x in r)
        if not items_ok:
            yield bad("rubric", "rubric must be a non-empty list of non-empty strings")
        else:
            first: dict[str, int] = {}
            for k, item in enumerate(r, 1):
                if item.strip() in first:  # prd_judge.py refuses it with exit 2: an answer cannot name each item
                    yield bad("rubric", f"rubric item {k} repeats item {first[item.strip()]}")
                else:
                    first[item.strip()] = k
        th = e.get("threshold")
        th_ok = not isinstance(th, bool) and isinstance(th, (int, float)) and 0 < th <= 1
        if not th_ok:
            yield bad("threshold" if "threshold" in e else "rubric", "threshold must be a number in (0, 1]")
        elif items_ok and len(r) >= 2:
            warn = _needs_every_item(th, len(r))
            if warn:
                yield Finding(tc.file, kl.get("threshold", eline), "judged-case", f"{tc.id}: {warn}", severity="warn")
        if "runs" in e and (isinstance(e["runs"], bool) or not isinstance(e["runs"], int) or e["runs"] < 1):
            yield bad("runs", "runs must be an integer of at least 1")
        if "output" in e:
            yield bad("output", "a judged case has no expect.output")


@rule("test-refs", description="Checks that each test case's references resolve: ac names an AC of the requirement its T-id is numbered for, preconditions name fixtures in testing.md and contracts/fixtures/ or mock services in contracts/dependencies/, input.file, error codes, refs entries, environment, identity and target exist, known-failing names an open errors.md entry and has a symptom: beside it (a warning when it has none), and a symptom: has a known-failing: beside it. Point the reference at something that exists or add what it names; delete a known-failing: line whose entry is resolved, and a symptom: with no known-failing: beside it.")
def test_refs(prd: Prd):
    all_acs = {ac.id for b in prd.blocks for ac in b.acs}
    errors_yaml = prd.yaml.get("contracts/errors.yaml")
    perms = prd.yaml.get("contracts/permissions.yaml")
    identities = {"none"}
    if isinstance(perms, dict) and isinstance(perms.get("roles"), dict):
        identities |= {r["identity"] for r in perms["roles"].values() if isinstance(r, dict) and isinstance(r.get("identity"), str)}
    ops, tables_, events = operation_ids(prd), {t.lower() for t in schema_tables(prd)}, event_names(prd)
    customs = custom_items(prd)
    packed = pack_kinds(prd)
    rows = {kind for kind, _, _, _ in custom_types(prd)}  # the section-7 types with a validator other than built-in

    for tc in _cases(prd):
        d = tc.data

        def bad(key: str, msg: str):
            return Finding(tc.file, _line(tc, key), "test-refs", f"{tc.id}: {msg}")

        ac = d.get("ac")
        if isinstance(ac, str) and ac:
            if ac not in all_acs:
                yield bad("ac", f"{ac} is not an acceptance criterion in any requirement block")
            am, tm = _AC_NUMBER.fullmatch(ac), _TID_NUMBER.fullmatch(tc.id)
            if am and tm and am.group(1) != tm.group(1):
                yield bad("ac", f"{ac} belongs to requirement {am.group(1)}, but {tc.id} is numbered for requirement {tm.group(1)}")

        for pre in d.get("preconditions") if isinstance(d.get("preconditions"), list) else []:
            if not isinstance(pre, str):
                yield bad("preconditions", f"precondition {pre!r} must be a fixture name or mock:<service>")
            elif pre.startswith("mock:"):
                if not (prd.root / f"contracts/dependencies/{pre[5:]}.yaml").is_file():
                    yield bad("preconditions", f"{pre} has no contracts/dependencies/{pre[5:]}.yaml")
            else:
                if pre not in prd.testing.fixtures:
                    yield bad("preconditions", f"fixture '{pre}' is not in the Fixtures table of testing.md")
                if not _exists_fixture(prd, pre):
                    yield bad("preconditions", f"fixture '{pre}' has no file or directory at contracts/fixtures/{pre}")

        inp = d.get("input")
        if isinstance(inp, dict) and isinstance(inp.get("file"), str):
            if not (prd.root / "contracts/fixtures" / inp["file"]).is_file():
                yield bad("input", f"input.file '{inp['file']}' does not exist under contracts/fixtures/")

        codes = _expect(tc).get("errors")
        if isinstance(errors_yaml, dict) and isinstance(codes, list):
            for code in codes:
                if not isinstance(code, str):
                    yield bad("expect", f"expect.errors item {code!r} must be an error code string")
                elif code not in errors_yaml:
                    yield bad("expect", f"error code {code} is not in contracts/errors.yaml")

        refs = d.get("refs")
        if refs is not None:
            for ref in refs if isinstance(refs, list) else [refs]:
                problem = _ref_problem(prd, ref)
                if problem:
                    yield bad("refs", problem)

        env = d.get("environment")
        if isinstance(env, str) and env and env not in prd.testing.environments:
            yield bad("environment", f"environment '{env}' is not in the Environments table of testing.md")
        ident = d.get("identity")
        if isinstance(ident, str) and ident and ident not in identities:
            yield bad("identity", f"identity '{ident}' is neither none nor a test identity in contracts/permissions.yaml")

        kf = d.get("known-failing")
        if kf is not None:
            entry = prd.errors_ledger.get(kf) if isinstance(kf, str) else None
            if entry is None:
                yield bad("known-failing", f"known-failing {kf!r} must be an E-nnn entry of errors.md")
            elif not entry.open:
                yield bad("known-failing", f"known-failing {kf} is resolved in errors.md; remove the line")

        sym = d.get("symptom")
        named = isinstance(sym, str) and sym.strip() != ""  # a blank or non-string symptom counts as absent
        if kf is None:
            if "symptom" in d:  # even a blank one: the key belongs beside known-failing: only
                yield bad("symptom", "symptom: needs known-failing: on the same case")
        elif not named:
            yield Finding(tc.file, _line(tc, "known-failing"), "test-refs",
                          f"{tc.id}: known-failing {kf} names no symptom; any failure would pass as it", severity="warn")

        target = d.get("target")
        if isinstance(target, str) and ":" in target and model.ref_prefix(prd, target) is None:  # a prefixed target is for upstream-refs
            kind, _, name = target.partition(":")
            if kind == "op" and name not in ops:
                yield bad("target", f"target {target}: no operationId '{name}' in contracts/openapi.yaml")
            elif kind == "table" and name.lower() not in tables_:
                yield bad("target", f"target {target}: no table '{name}' in contracts/schema.sql")
            elif kind in ("event", "job") and name not in events:
                yield bad("target", f"target {target}: no '### {name}' heading in contracts/events.md and no such asyncapi channel or operation")
            elif kind in packed and packed[kind] not in rows:
                yield bad("target", f"target {target}: contract type {packed[kind]} has no §7 row (Validator pack)")
            elif kind in packed and kind in customs and name not in customs[kind]:
                yield bad("target", f"target {target}: no {packed[kind]} entry '{name}'")
            elif kind in customs and name not in customs[kind]:
                yield bad("target", f"target {target}: '{name}' is not an item of the {kind} files (items: {', '.join(sorted(customs[kind]))})")


@rule("deny-tested", description="Checks that every deny cell of contracts/permissions.yaml has a role with a test identity and a test case with target op:<operation>, that identity and a non-empty expect.errors. Give the role an identity, or add the case that proves the denial.")
def deny_tested(prd: Prd):
    perms = prd.yaml.get("contracts/permissions.yaml")
    if not isinstance(perms, dict):
        return
    roles = perms.get("roles") if isinstance(perms.get("roles"), dict) else {}
    ops = perms.get("operations") if isinstance(perms.get("operations"), dict) else {}
    for op, cell in ops.items():
        if not isinstance(cell, dict):
            continue
        line = getattr(cell, "key_lines", {}).get("deny") or getattr(ops, "key_lines", {}).get(op, 1)
        deny = cell.get("deny")
        for role in deny if isinstance(deny, list) else []:
            if not isinstance(role, str):
                continue  # contracts-valid reports the shape
            ident = (roles.get(role) or {}).get("identity") if isinstance(roles.get(role), dict) else None
            if not ident:
                yield Finding("contracts/permissions.yaml", line, "deny-tested", f"deny cell ({op}, {role}): role '{role}' has no test identity")
                continue
            tested = any(
                tc.data.get("target") == f"op:{op}" and tc.data.get("identity") == ident and _expect(tc).get("errors")
                for tc in _cases(prd)
            )
            if not tested:
                yield Finding("contracts/permissions.yaml", line, "deny-tested", f"deny cell ({op}, {role}) has no test case with target op:{op}, identity {ident} and expect.errors")


# ---- classified-fixtures


def _pii_columns(prd: Prd) -> dict[str, set[str]]:
    data = prd.yaml.get("contracts/data-classification.yaml")
    out: dict[str, set[str]] = {}
    for table, spec in (data.get("tables") if isinstance(data, dict) and isinstance(data.get("tables"), dict) else {}).items():
        cols = spec.get("columns") if isinstance(spec, dict) else None
        if isinstance(cols, dict):
            out[str(table)] = {str(c) for c, kind in cols.items() if kind == "pii"}
    return out


def _strings(node) -> Iterator[str]:
    if isinstance(node, dict):
        for v in node.values():
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)
    elif isinstance(node, str):
        yield node


def _line_of(text: str, value: str, default: int = 1) -> int:
    i = text.find(value)
    return text.count("\n", 0, i) + 1 if i >= 0 else default


@rule("classified-fixtures", description="Checks that no fixture file under contracts/fixtures/ holds a real-looking email, phone number or SSN in a column contracts/data-classification.yaml classifies pii, and that no test case's inline input holds one in any value. Use a synthetic form: an example.com address, a 555-01xx phone number, or an SSN starting 000, 666 or 9.")
def classified_fixtures(prd: Prd):
    pii = _pii_columns(prd)

    def real(value) -> list[str]:
        return [v for v in pii_values(str(value)) if not is_synthetic(v)]

    base = prd.root / "contracts/fixtures"
    for path in sorted(base.rglob("*")) if base.is_dir() else []:
        if not path.is_file():
            continue
        rel = path.relative_to(prd.root).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        suffix = path.suffix.lower()
        if suffix == ".csv":
            table = path.parent.name if path.parent != base else path.stem
            cols = pii.get(table, set())
            reader = csv.reader(io.StringIO(text))
            header = next(reader, [])
            for row in reader:
                for col, value in zip(header, row):
                    if col in cols:
                        for v in real(value):
                            yield Finding(rel, reader.line_num, "classified-fixtures", f"{table}.{col} is classified pii but holds the real-looking value '{v}'")
        elif suffix in (".yaml", ".yml", ".json"):
            try:
                data = json.loads(text) if suffix == ".json" else yaml.safe_load(text)
            except Exception:
                continue  # contracts-valid reports YAML that does not parse
            for table, rows in (data.items() if isinstance(data, dict) else []):
                for row in rows if isinstance(rows, list) else []:
                    for col, value in (row.items() if isinstance(row, dict) else []):
                        if col in pii.get(str(table), set()):
                            for v in real(value if not isinstance(value, (dict, list)) else " ".join(_strings(value))):
                                yield Finding(rel, _line_of(text, v), "classified-fixtures", f"{table}.{col} is classified pii but holds the real-looking value '{v}'")
    for tc in _cases(prd):
        inp = tc.data.get("input")
        for s in _strings(inp):
            for v in real(s):
                yield Finding(tc.file, _line(tc, "input"), "classified-fixtures", f"{tc.id}: inline input holds the real-looking PII value '{v}'; use a synthetic form")
