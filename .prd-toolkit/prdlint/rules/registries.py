"""Registry rules (registries, runbook-actors) and the skill-installed lookup."""
import os
import re
import shlex
import shutil
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from ..errorreplay import malformed_one_test
from ..findings import Finding
from ..markdown import sections, tables
from ..model import DRIFT_CHECKS, Prd, gate_of, production_envs, repo_root
from ..packs import installed_plugins
from ..registry import rule

STANDARDS_DECISIONS = {"enforced", "declined", "proposed"}
SKILLS_DECISIONS = {"required", "recommended", "declined", "proposed"}


def installed_skill(skill: str, repo_root: Path) -> bool:
    """A bare skill is installed when its SKILL.md exists under ~/.claude/skills or <repo>/.claude/skills.

    `plugin:skill` needs a `plugin@...` key in the plugins file. When an install of that plugin records an
    `installPath`, `<installPath>/skills/<skill>/SKILL.md` must also exist; without one, plugin presence is enough."""
    if ":" in skill:
        plugin, name = skill.split(":", 1)
        entries = [v for k, v in installed_plugins().items() if k.startswith(plugin + "@")]
        if not entries:
            return False
        installs = [i for v in entries for i in v]
        paths = [i["installPath"] for i in installs if isinstance(i, dict) and isinstance(i.get("installPath"), str)]
        return not paths or any((Path(p) / "skills" / name / "SKILL.md").is_file() for p in paths)
    return any((base / ".claude/skills" / skill / "SKILL.md").is_file() for base in (Path.home(), repo_root))


def _registry_rows(prd: Prd, number: int) -> Iterator:
    sec = next((s for s in prd.sections if s.number == number), None)
    for t in tables(sec.body) if sec else []:
        yield from t.rows


def _command(cell: str) -> str | None:
    """First token of the first backticked span."""
    m = re.search(r"`([^`]*)`", cell)
    if not m:
        return None
    try:
        tokens = shlex.split(m.group(1))
    except ValueError:
        tokens = m.group(1).split()
    return tokens[0] if tokens else None


@dataclass(frozen=True)
class StandardsRow:
    glob: str
    command: str
    decision: str
    line: int


def standards_rows(prd: Prd) -> list[StandardsRow]:
    """The §5 rows: glob without backticks, the whole first backticked span as the command, the Decision cell."""
    rows = []
    for r in _registry_rows(prd, 5):
        cells = [c.strip() for c in r.cells] + [""] * 5
        m = re.search(r"`([^`]*)`", cells[1])
        rows.append(StandardsRow(cells[0].replace("`", "").strip(), m.group(1).strip() if m else "",
                                 cells[4].strip("`").strip(), r.line))
    return rows


@rule("registries", description="Checks the section 5 and 6 registries: each Decision is one of its table's values, no row is proposed while the PRD is Approved, an enforced standard has a backticked linter command on PATH, and a required skill is installed. Fix the Decision or the command, install the skill, or mark a skill built into Claude Code recommended.")
def registries(prd: Prd) -> Iterator[Finding]:
    approved = prd.frontmatter.get("status", "").strip() == "Approved"
    ci = os.environ.get("PRD_LINT_CI") == "1"  # prd_lint.py --ci: skip the checks that depend on the machine
    for r in _registry_rows(prd, 5):
        cells = [c.strip() for c in r.cells] + [""] * 5
        decision = cells[4].strip("`").strip()
        if decision not in STANDARDS_DECISIONS:
            yield Finding("prd.md", r.line, "registries", f"standards Decision '{decision}' is not one of enforced, declined, proposed")
            continue
        if decision == "proposed" and approved:
            yield Finding("prd.md", r.line, "registries", "standards row is still 'proposed' but the PRD is Approved")
        if decision == "enforced":
            cmd = _command(cells[1])
            if cmd is None:  # no command at all is a finding anywhere, CI included
                yield Finding("prd.md", r.line, "registries", f"enforced standards row has no linter command ('{cells[1]}'); put it in backticks")
            elif not ci and shutil.which(cmd) is None:  # --ci skips only the on-PATH lookup
                yield Finding("prd.md", r.line, "registries", f"enforced linter command '{cmd}' is not on PATH")
    root = None
    for r in _registry_rows(prd, 6):
        cells = [c.strip() for c in r.cells] + [""] * 3
        skill, decision = cells[1].strip("`").strip(), cells[2].strip("`").strip()
        if decision not in SKILLS_DECISIONS:
            yield Finding("prd.md", r.line, "registries", f"skills Decision '{decision}' is not one of required, recommended, declined, proposed")
            continue
        if decision == "proposed" and approved:
            yield Finding("prd.md", r.line, "registries", "skills row is still 'proposed' but the PRD is Approved")
        if decision == "required" and not ci:
            root = root or repo_root(prd.root)
            if not installed_skill(skill, root):
                yield Finding("prd.md", r.line, "registries", f"required skill '{skill}' is not installed; if it is built into Claude Code, mark the row 'recommended'")


MIGRATION_HINT = " (prd-toolkit 0.5 runbook format)"
_RUN_SHAPE = "step {n}: {label} must be one backticked command or tests <level>[, <level>]"


@rule("runbook-steps", description="Checks the operations.md runbook: steps numbered from 1 with no gap, each with (actor: agent|human) (env: <environment>), an agent step's Run:, Check: and Rollback: in their forms, a human step's Do: and Check:, and no label twice. Rewrite the step to the form the message gives.")
def runbook_steps(prd: Prd) -> Iterator[Finding]:
    text = prd.docs.get("operations.md")
    if text is None:
        return
    ops = prd.operations
    old_format = bool(ops.steps) and not any(s.env is not None for s in ops.steps) and "(env:" not in text
    first = True

    def out(line: int, msg: str) -> Finding:
        nonlocal first
        msg += MIGRATION_HINT if first and old_format else ""
        first = False
        return Finding("operations.md", line, "runbook-steps", msg)

    def marked(label: str, s) -> bool:  # an unfilled [NEEDS CLARIFICATION: ...] value is the markers-open rule's business
        return "[NEEDS CLARIFICATION:" in s.labels[label][0]

    expected = 1
    for s in ops.steps:
        n = s.number
        if s.number != expected:
            yield out(s.line, f"step {n}: expected step {expected}")
        expected = s.number + 1
        for label, line in s.repeated:
            yield out(line, f"step {n}: label {label} appears twice")
        if s.actor is None:
            yield out(s.line, f"step {n}: the step line needs (actor: agent|human) (env: <environment>)")
            continue
        labels = s.labels
        if s.actor == "human":
            bad = [k for k in ("Run", "Rollback") if k in labels]
            if bad:
                yield out(labels[bad[0]][1], f"step {n}: a human step takes Do: and Check:, not {' or '.join(k + ':' for k in bad)}")
            elif "Do" not in labels or "Check" not in labels:
                yield out(s.line, f"step {n}: a human step needs Do: and Check:")
            continue
        if "Do" in labels:
            yield out(labels["Do"][1], f"step {n}: an agent step takes Run:, Check: and Rollback:, not Do:")
        if "Run" not in labels:
            yield out(s.line, f"step {n}: an agent step needs Run:")
        elif s.run is None and s.tests is None and not marked("Run", s):
            yield out(labels["Run"][1], _RUN_SHAPE.format(n=n, label="Run:") + f"; got '{labels['Run'][0]}'")
        if s.tests is not None:
            if not s.tests:
                yield out(labels["Run"][1], f"step {n}: a tests step names no levels")
            if "Check" in labels:
                yield out(labels["Check"][1], f"step {n}: a tests step has no Check:")
            if "Rollback" in labels and s.rollback is None and not marked("Rollback", s):
                yield out(labels["Rollback"][1], f"step {n}: Rollback: must be one backticked command; got '{labels['Rollback'][0]}'")
            continue
        if "Check" not in labels:
            yield out(s.line, f"step {n}: an agent step needs Check:")
        elif s.prints is not None and s.matches is not None:
            yield out(labels["Check"][1], f"step {n}: Check: takes prints or matches, not both")
        elif s.check is None and not marked("Check", s):
            yield out(labels["Check"][1], f"step {n}: Check: must be one backticked command, optionally followed by prints `<text>`; got '{labels['Check'][0]}'")
        if s.matches is not None and s.prints is None:
            try:
                re.compile(s.matches)
            except re.error as e:
                yield out(labels["Check"][1], f"step {n}: matches pattern '{s.matches}' does not compile: {e}")
        if "Rollback" in labels and s.rollback is None and not marked("Rollback", s):
            yield out(labels["Rollback"][1], f"step {n}: Rollback: must be one backticked command; got '{labels['Rollback'][0]}'")


def _git_accepts_branch(name: str) -> bool:
    try:
        return subprocess.run(["git", "check-ref-format", "--branch", name], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return True  # no git on the runner: nothing to refuse with


@rule("runbook-env", description="Checks that operations.md Environments has a Production column with yes or no on every row and at least one yes, and a valid branch name or blank in each Branch cell, that every environment there is also in testing.md Environments, and that each runbook step and Deployed or Drift row names an environment of both tables. Add the environment to both tables or correct the name the message gives, add the Production column or set a row's Production to yes or no, and write a valid branch name or leave the Branch blank.")
def runbook_env(prd: Prd) -> Iterator[Finding]:
    if "operations.md" not in prd.docs:
        return
    ops = prd.operations
    testing = prd.testing.environments

    def unknown(env: str) -> str:
        near = next((e for e in ops.environments if e.lower() == env.lower()), None)
        return f"environment '{env}' is not in operations.md Environments" + (f" (did you mean '{near}'?)" if near else "")

    def check(env: str, line: int, prefix: str) -> Iterator[Finding]:
        if env not in ops.environments:
            yield Finding("operations.md", line, "runbook-env", prefix + unknown(env))
        elif env not in testing:
            yield Finding("operations.md", line, "runbook-env", f"{prefix}environment '{env}' is not in testing.md Environments")

    for env, line in ops.environments.items():
        if env not in testing:
            yield Finding("operations.md", line, "runbook-env", f"environment '{env}' is in operations.md but not in testing.md Environments")
        if ops.has_production and ops.production.get(env) not in ("yes", "no"):
            yield Finding("operations.md", line, "runbook-env", f"environment '{env}': Production '{ops.production.get(env)}' is not yes or no")
    if ops.environments:
        first = min(ops.environments.values())
        if not ops.has_production:
            yield Finding("operations.md", first, "runbook-env", "operations.md Environments has no Production column")
        elif not production_envs(prd):
            yield Finding("operations.md", first, "runbook-env", "operations.md Environments: no environment has Production yes")
    for env, branch in ops.branches.items():
        if branch and not _git_accepts_branch(branch):
            yield Finding("operations.md", ops.environments.get(env, 0), "runbook-env", f"environment '{env}': Branch '{branch}' is not a valid branch name")
    for s in ops.steps:
        if s.env is not None:
            yield from check(s.env, s.line, f"step {s.number}: ")
    for d in ops.deployed:
        yield from check(d.env, d.line, "Deployed row: ")
    for d in ops.drift:
        yield from check(d.env, d.line, "Drift row: ")


@rule("production-gate", description="Checks that the first runbook step on each production environment is a human step or directly follows one. Add a human approval step just before it.")
def production_gate(prd: Prd) -> Iterator[Finding]:
    steps = prd.operations.steps
    for env in sorted(production_envs(prd)):
        i = next((i for i, s in enumerate(steps) if s.env == env), None)
        if i is None:
            continue
        if steps[i].actor != "human" and not (i > 0 and steps[i - 1].actor == "human"):
            yield Finding("operations.md", steps[i].line, "production-gate",
                          f"step {steps[i].number} deploys {env} with no human step at or just before it")


@rule("runbook-tests", description="Checks that each level a runbook tests step names is in testing.md Levels with Gate deploy and a Harness command, that each Timeout cell is a whole number of seconds of at least 1, and that each One test cell is one simple command in backticks. Add or fix the level's row, or name a deploy-gate level.")
def runbook_tests(prd: Prd) -> Iterator[Finding]:
    for level, cell in prd.testing.timeouts.items():
        if cell and not (re.fullmatch(r"[0-9]+", cell) and int(cell) >= 1):
            yield Finding("testing.md", prd.testing.levels.get(level, 0), "runbook-tests",
                          f"level '{level}': Timeout '{cell}' is not a whole number of seconds of at least 1")
    for level, cell in prd.testing.one_tests.items():  # FR-075
        if malformed_one_test(cell):
            yield Finding("testing.md", prd.testing.levels.get(level, 0), "runbook-tests",
                          f"level '{level}': One test '{cell.strip()}' is not one simple command in backticks")
    for s in prd.operations.steps:
        for level in s.tests or []:
            line = s.labels["Run"][1]
            if level not in prd.testing.levels:
                yield Finding("operations.md", line, "runbook-tests", f"step {s.number}: level '{level}' is not in testing.md Levels")
                continue
            gate = gate_of(prd, level)
            if gate != "deploy":
                yield Finding("operations.md", line, "runbook-tests", f"step {s.number}: level '{level}' has Gate {gate or 'none'}; a tests step runs deploy-gate levels")
            elif not prd.testing.commands.get(level) and "[NEEDS CLARIFICATION:" not in prd.testing.command_cells.get(level, ""):
                yield Finding("operations.md", line, "runbook-tests", f"step {s.number}: level '{level}' has no Harness command")


@rule("drift-rows", description="Checks that each Drift row's Check is version or config, and that a config row has contracts/config.yaml. Use one of the two checks, or add the config contract.")
def drift_rows(prd: Prd) -> Iterator[Finding]:
    for d in prd.operations.drift:
        if d.check == "schema":
            yield Finding("operations.md", d.line, "drift-rows", "check 'schema': schema drift arrives in prd-toolkit 0.6")
        elif d.check not in DRIFT_CHECKS:
            yield Finding("operations.md", d.line, "drift-rows", f"check '{d.check}' is not version or config")
        elif d.check == "config" and not (prd.root / "contracts/config.yaml").is_file():
            yield Finding("operations.md", d.line, "drift-rows", "a config drift row needs contracts/config.yaml")
