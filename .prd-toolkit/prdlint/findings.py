from dataclasses import dataclass, field


@dataclass(frozen=True, order=True)
class Finding:
    """One violation. `file` is relative to the PRD root; `line` is 1-based, 0 for a whole file."""

    file: str
    line: int
    rule: str
    message: str
    severity: str = field(default="error", compare=False)  # "error" or "warn"

    def __str__(self) -> str:
        tag = "warn: " if self.severity == "warn" else ""
        return f"{self.file}:{self.line}: {tag}{self.rule}: {self.message}"
