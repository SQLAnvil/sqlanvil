"""The hooks `prd_hooks.py install` writes where core.hooksPath is set (FR-070): the toolkit's own are rewritten, as
where it is not set; a hook that is absent or the user's own is left alone, with the line to add or replace."""
from pathlib import Path


def install_configured(hooks_dir: Path, shown: str, configured: str, prd_rel: str) -> list[str]:
    """One line per hook, commit-msg before pre-commit: the toolkit's own is written as install writes it where
    core.hooksPath is not set (AC-070.1); any other is left as it is, with the instruction to add or replace (AC-070.2)."""
    from . import hooks  # local: hooks imports this module

    lines = []
    for hook in hooks.HOOKS:
        path = Path(hooks_dir) / hook
        if path.is_file() and hooks._ours(path):
            lines.append(hooks._write_shim(path, hook, prd_rel, shown))
        else:
            lines.append(hooks._append_message(hook, prd_rel, shown, f"core.hooksPath is set to {configured}; no shim written", hooks._read(path)))
    return lines
