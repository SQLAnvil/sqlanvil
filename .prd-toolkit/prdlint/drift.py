"""prd_drift's engine: run each Drift row's introspection command and compare with the PRD."""
import json
from pathlib import Path

from . import deploy
from .findings import Finding
from .model import Prd

TIMEOUT = 120
OPS = "operations.md"


def _setting_value(spec: dict, env: str):
    envs = spec.get("environments") or {}
    if env in envs:
        return True, envs[env]
    if "default" in spec:
        return True, spec["default"]
    return False, None


def _j(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def _config_findings(prd: Prd, row, actual: dict) -> list[Finding]:
    cfg = prd.yaml.get("contracts/config.yaml") or {}
    settings = cfg.get("settings") if isinstance(cfg, dict) else None
    settings = settings if isinstance(settings, dict) else {}
    out: list[Finding] = []
    for name, spec in settings.items():
        has, want = _setting_value(spec if isinstance(spec, dict) else {}, row.env)
        if not has:
            continue
        if name not in actual:
            out.append(Finding(OPS, row.line, "drift-config", f"{row.env} is missing {name}; config.yaml says {_j(want)}"))
        elif not _same(actual[name], want):
            out.append(Finding(OPS, row.line, "drift-config", f"{row.env} {name} is {_j(actual[name])}; config.yaml says {_j(want)}"))
    for name in actual:
        if name not in settings:
            out.append(Finding(OPS, row.line, "drift-config", f"{row.env} has {name}, which config.yaml does not define"))
    return out


def _same(a, b) -> bool:
    """Parsed-value equality that keeps `true` apart from `1`."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


def drift_findings(prd: Prd, repo_root: Path, env: str | None, timeout: int = TIMEOUT) -> tuple[list[Finding], list[str]]:
    """Drift findings in table order, and tool errors."""
    findings: list[Finding] = []
    errors: list[str] = []
    for row in prd.operations.drift:
        if env is not None and row.env != env:
            continue
        where = f"{OPS}:{row.line}: drift {row.env} {row.check}"
        if row.check not in ("version", "config"):
            why = "schema drift arrives in prd-toolkit 0.6" if row.check == "schema" else "checks are version and config"
            errors.append(f"{where}: not supported ({why})")
            continue
        if row.check == "config" and not isinstance(prd.yaml.get("contracts/config.yaml"), dict):
            errors.append(f"{where}: contracts/config.yaml does not exist")
            continue
        if not row.command:
            errors.append(f"{where}: has no command")
            continue
        r = deploy._execute(row.command, repo_root, {"PRD_ENV": row.env}, timeout)
        if r["timed_out"]:
            errors.append(f"{where}: timed out after {timeout} s")
            continue
        if r["exit"] != 0:
            errors.append(f"{where}: the command exited {r['exit']}")
            continue
        text = r["out"].decode("utf-8", errors="replace").strip()
        if row.check == "version":
            if not text:
                errors.append(f"{where}: the command printed nothing")
                continue
            want = next((d.version for d in prd.operations.deployed if d.env == row.env), None)
            if want is None:
                findings.append(Finding(OPS, row.line, "drift-version", f"{row.env} has no Deployed row"))
            elif text != want:
                findings.append(Finding(OPS, row.line, "drift-version", f"{row.env} runs {text}; Deployed says {want}"))
        elif row.check == "config":
            try:
                actual = json.loads(text)
            except ValueError:
                actual = None
            if not isinstance(actual, dict):
                errors.append(f"{where}: the output is not a JSON object")
                continue
            findings.extend(_config_findings(prd, row, actual))
    return findings, errors
