"""YAML loading that keeps line numbers and reports duplicate keys."""
from pathlib import Path
from typing import Any

from .deps import require
from .findings import Finding

yaml = require("yaml", "pyyaml")


class LineDict(dict):
    """A mapping that remembers where it and each key were defined (1-based)."""

    line: int = 0

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.key_lines: dict[Any, int] = {}


class _Loader(yaml.SafeLoader):
    def __init__(self, stream):
        super().__init__(stream)
        self.dups: list[tuple[Any, int, int]] = []  # (key, first line, duplicate line)

    def construct_line_map(self, node):
        data = LineDict()
        data.line = node.start_mark.line + 1
        yield data
        self.flatten_mapping(node)
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=True)
            value = self.construct_object(value_node, deep=False)
            line = key_node.start_mark.line + 1
            try:
                hash(key)
            except TypeError:
                # a list or mapping key: a parse error at the key, as PyYAML's own constructor reports it
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping", node.start_mark, "found unhashable key", key_node.start_mark
                ) from None
            if key in data:
                self.dups.append((key, data.key_lines[key], line))
                continue  # the first value wins
            data[key] = value
            data.key_lines[key] = line


_Loader.add_constructor("tag:yaml.org,2002:map", _Loader.construct_line_map)


def load_yaml(path: Path, rel: str) -> tuple[Any, list[Finding]]:
    """Load a mapping-rooted YAML file. `rel` is the path relative to the PRD root.

    test-cases/*: duplicate key -> id-unique; parse error or non-mapping -> sufficiency.
    Everything else (contracts/**): contracts-valid. Returns (None, findings) on error.
    """
    in_cases = rel.startswith("test-cases/")
    dup_rule = "id-unique" if in_cases else "contracts-valid"
    bad_rule = "sufficiency" if in_cases else "contracts-valid"
    loader = _Loader(path.read_text(encoding="utf-8"))
    try:
        data = loader.get_single_data()
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        problem = getattr(e, "problem", None) or str(e)
        return None, [Finding(rel, mark.line + 1 if mark else 0, bad_rule, f"YAML parse error: {problem}")]
    finally:
        loader.dispose()
    findings = [
        Finding(rel, dup, dup_rule, f"duplicate key '{key}' (first at line {first}, again at line {dup})")
        for key, first, dup in loader.dups
    ]
    if not isinstance(data, dict):
        return None, findings + [Finding(rel, 1, bad_rule, "top level must be a mapping")]
    return data, findings
