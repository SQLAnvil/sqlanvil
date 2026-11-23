"""Optional-import helper: a missing dependency prints an install hint and exits 2."""
import importlib
import re
import sys
import tomllib
from pathlib import Path

_HEADER = re.compile(r"^# /// script\n(?P<body>.*?)^# ///$", re.M | re.S)
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _header_packages(script: Path) -> list[str]:
    """The package names of a uv script's inline dependency header, in order, without version specifiers."""
    try:
        m = _HEADER.search(script.read_text(encoding="utf-8"))
        if not m:
            return []
        body = "\n".join(line[2:] if line.startswith("# ") else line[1:] for line in m.group("body").splitlines())
        deps = tomllib.loads(body).get("dependencies", [])
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError):
        return []
    return [n.group(0) for d in deps if isinstance(d, str) and (n := _NAME.match(d.strip()))]


def require(module: str, package: str):
    try:
        return importlib.import_module(module)
    except ImportError:
        path = Path(sys.argv[0])
        script = path.name or "<script>"
        packages = " ".join(_header_packages(path))
        print(
            f"{path.stem or script}: missing Python package '{package}'. Run with: uv run --script {script} …, "
            f"or: pip install {packages}",
            file=sys.stderr,
        )
        sys.exit(2)
