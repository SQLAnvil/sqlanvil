"""Pack rules (0.8.0): pack-resolves, platform-word."""
import re
from pathlib import Path

from .. import packs
from ..findings import Finding
from ..model import Prd
from ..registry import rule


@rule("pack-resolves", description="Checks the profile lines (Pack: and Output language: in section 1, Target: in a features file), one each, in their form and position, and that each pack they name resolves at one version from its source, with a valid pack.yaml that fits this toolkit. Fix the line's form or position, delete a repeated line, and name one version per pack; run prd_hooks.py install when the vendored copy differs or lost its pack.yaml; for a pack not found, invalid or needing another toolkit, correct its name, version or source, install the plugin that ships it, or name a version that fits.")
def pack_resolves(prd: Prd):
    """Malformed, repeated or misplaced profile lines, then each named pack that does not resolve, on the line naming it."""
    for file, line, message in prd.profile_problems:
        yield Finding(file, line, "pack-resolves", message)
    refs = packs.named(prd)
    versions: dict[str, list[str]] = {}
    for ref in refs:
        versions.setdefault(ref.name, [])
        if ref.version not in versions[ref.name]:
            versions[ref.name].append(ref.version)
    reported: set[str] = set()
    for ref in refs:
        first = versions[ref.name][0]
        if ref.version != first:
            if ref.name not in reported:
                reported.add(ref.name)
                vs = versions[ref.name]
                listed = ", ".join(vs[:-1]) + " and " + vs[-1]
                yield Finding(ref.file, ref.line, "pack-resolves", f"pack {ref.name} named at {listed}; one version per PRD")
            continue
        try:
            packs.resolve_cached(prd, ref)
        except (packs.ManifestError, packs.PackNotFound, packs.PackMismatch) as e:
            yield Finding(ref.file, ref.line, "pack-resolves", str(e))
        except (OSError, ValueError) as e:
            yield Finding(ref.file, ref.line, "pack-resolves", f"pack {ref.name}: {packs.MANIFEST}: {e}")


@rule("platform-word", severity="warn", description="Warns when a requirement title or a live AC names a word of its area's pack vocabulary, a detail of the platform rather than the behaviour. Move the word to a contract, a Harness slot or the area's Target: line; a warning never fails a gate.")
def platform_word(prd: Prd):
    """A requirement title or live AC that names a word of its area's pack vocabulary (a soft warning)."""
    for b in prd.blocks:
        if b.status == "removed":
            continue
        pack = packs.pack_for(prd, None if b.kind == "NFR" else Path(b.file).stem)
        if pack is None or not pack.vocabulary:
            continue
        items = [(b.line, b.id, b.title)]
        items += [(a.line, a.id, a.text) for a in b.acs if not a.removed]
        for line, ident, text in items:
            for word in pack.vocabulary:
                if re.search(rf"\b{re.escape(word)}\b", text, re.IGNORECASE):
                    yield Finding(b.file, line, "platform-word",
                                  f"{ident} names '{word}', a word of pack {pack.name}: "
                                  "move it to a contract, a Harness slot or the area's Target", severity="warn")
