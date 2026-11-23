"""Whether a changed path is a tester's test: it lies under a test root of testing.md and cites a non-unit T-id."""
from collections.abc import Iterable

from .model import Prd
from .trace import DEFAULT_TEST_ROOTS, cited_tids


def roots_of(prd: Prd) -> list[str]:
    """The test roots of the Layout line of testing.md as it stands on disk, each less the white space around it
    and every `/` at its end; `tests` when the file holds no `Test roots:` text or its list is empty."""
    return [r.strip().rstrip("/") for r in (prd.testing.harness.test_roots or DEFAULT_TEST_ROOTS)]


def lies_under(path: str, roots: Iterable[str]) -> bool:
    """`path` (from the repository root, `/` between its parts) equals a root or starts with the root and `/`."""
    return any(path == root or path.startswith(root + "/") for root in roots)


def tester_tids(path: str, texts: Iterable[str], levels: dict[str, object], roots: Iterable[str]) -> list[str]:
    """The T-ids that make `path` a tester's test, each once, in the order of their first citation across `texts`
    (the text at the base, then at the head): those whose test case is not `level: unit`, a T-id with no test
    case among them. [] when `path` lies under no test root, whatever its text cites."""
    if not lies_under(path, roots):
        return []
    cited: dict[str, None] = {}
    for text in texts:
        for tid in cited_tids(text):
            cited[tid] = None
    return [t for t in cited if levels.get(t) != "unit"]
