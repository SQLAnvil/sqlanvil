"""Lint rule registry. Rule modules register with @rule("name") when imported."""
from collections.abc import Callable, Iterable

from .findings import Finding
from .model import Prd

RULES: dict[str, Callable[[Prd], Iterable[Finding]]] = {}
SEVERITY: dict[str, str] = {}  # rule name -> "error" (default) or "warn"
DESCRIPTION: dict[str, str] = {}  # rule name -> what it checks and how to clear a finding; prd_help.py prints it, lint never


class RuleCrash(Exception):
    def __init__(self, rule: str, exc: Exception):
        super().__init__(f"internal error in rule {rule}: {type(exc).__name__}: {exc}")
        self.rule = rule
        self.exc = exc


def rule(name: str, severity: str = "error", description: str = ""):
    def register(fn):
        RULES[name] = fn
        SEVERITY[name] = severity
        DESCRIPTION[name] = description
        return fn

    return register


def run(prd: Prd, only: set[str] | None = None, warnings: bool = False) -> list[Finding]:
    from . import rules  # noqa: F401  (importing registers every rule module)

    findings = list(prd.load_findings)
    for name, fn in list(RULES.items()):
        if only is not None and name not in only:
            continue
        try:
            findings.extend(fn(prd))
        except Exception as exc:
            raise RuleCrash(name, exc) from exc
    if not warnings:
        findings = [f for f in findings if f.severity != "warn"]
    return sorted(findings, key=lambda f: (f.file, f.line, f.rule))
