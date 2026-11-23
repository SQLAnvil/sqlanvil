"""Mermaid diagrams as inline SVG for the published page: the renderer sits behind `render_svg`, and every SVG is
checked before it is used. The renderer (mermaidx) is imported inside the render only, so this module, vendored or
not, imports without it."""
import functools
import html
import re

CONFIG = {"htmlLabels": False, "flowchart": {"htmlLabels": False}, "securityLevel": "strict"}


class Fallback(Exception):
    """The diagram is shown as its source; `reason` says why."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _render(source: str) -> str:
    import mermaidx  # the one place the renderer is needed
    return mermaidx.render(source, config=CONFIG).svg()


def _first_line(e: Exception) -> str:
    text = str(e).strip()
    return text.splitlines()[0] if text else type(e).__name__


@functools.lru_cache(maxsize=None)
def _raw(source: str) -> tuple[str, str]:
    """(SVG, "") or ("", reason); a page shows its §4 diagram twice, and it is drawn once."""
    try:
        return _render(source), ""
    except ImportError as e:
        return "", f"the renderer cannot load: {_first_line(e)}"
    except Exception as e:  # noqa: BLE001 - any failure of the renderer shows the source
        return "", f"the renderer failed: {_first_line(e)}"


def render_svg(source: str, number: int) -> str:
    """The diagram as an SVG whose IDs all belong to `diagram-<number>`; raises Fallback for any failure."""
    svg, reason = _raw(source)
    if reason:
        raise Fallback(reason)
    try:
        svg = _number(svg, number)
        refused = check_svg(svg)
    except Exception as e:  # noqa: BLE001 - a diagram never stops the publish; it shows its source
        raise Fallback(f"the SVG could not be read: {type(e).__name__}: {_first_line(e)}") from None
    if refused:
        raise Fallback(refused)
    return svg


# ---- IDs -----------------------------------------------------------------------------------------

_ID = re.compile(r'(?<=\s)id="([^"]*)"')
_ARIA = re.compile(r'(\saria-(?:labelledby|describedby)=")([^"]*)"')
_MARKUP = re.compile(r"<style\b[^>]*>.*?</style>|<[^>]*>", re.S)


def _opening(segment: str) -> str:
    """A markup segment's own tag: a `<style>` segment's opening tag, without the sheet it holds."""
    return segment[: segment.index(">") + 1]


_LINK = r"""url\(\s*["']?\s*#|[\s:]href\s*=\s*["']?\s*#"""  # what a `url(` or an href value starts with
_TARGET = r"""[^\s"')>]+"""


def _number(svg: str, number: int) -> str:
    """The root SVG's ID becomes `diagram-<number>` and every other ID `diagram-<number>-<id>`, with each `#id`
    reference and aria ID list in the markup and the style following; text between tags is left alone. A `url(#…)`
    or `href="#…"` names the diagram's own namespace even when no element has that ID (mermaid's sequence style
    points at `#drop-shadow`, which it never defines): a dangling reference stays dangling, inside the diagram."""
    root = re.match(r'\s*<svg\b[^>]*?\sid="([^"]*)"', svg)
    # from the tags only: mermaid leaves a raw `"` in label text, where `z id="q` would read as an ID
    ids = {i for m in _MARKUP.finditer(svg) for i in _ID.findall(_opening(m.group(0)))}
    new = {i: f"diagram-{number}" if root and i == root.group(1) else f"diagram-{number}-{i}" for i in ids}
    known = "|".join(re.escape(i) for i in sorted(new, key=len, reverse=True))
    ref = re.compile(rf"(?P<link>(?i:{_LINK}))(?P<target>{_TARGET})" + (rf"|#(?P<id>{known})(?![\w-])" if known else ""))

    def target(name: str) -> str:
        return new.get(name, f"diagram-{number}-{name}")

    def markup(m: re.Match) -> str:
        s = m.group(0)
        tag = _opening(s)
        s = _ID.sub(lambda k: f'id="{new.get(k.group(1), k.group(1))}"', tag) + s[len(tag) :]
        s = _ARIA.sub(lambda k: k.group(1) + " ".join(new.get(t, t) for t in k.group(2).split()) + '"', s)
        return ref.sub(lambda k: k.group("link") + target(k.group("target")) if k.group("link") else "#" + new.get(k.group("id"), k.group("id")), s)

    return _MARKUP.sub(markup, svg)


# ---- the check -----------------------------------------------------------------------------------

# SVG elements an HTML page may hold inline; any other tag (an HTML element breaks out of the SVG) is refused, as are
# script, foreignObject, the animation elements (they can set an href) and image/feImage (they only load).
_SVG_TAGS = frozenset(t.lower() for t in (
    "a circle clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix "
    "feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR "
    "feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile "
    "feTurbulence filter g line linearGradient marker mask metadata path pattern polygon polyline radialGradient rect "
    "stop style svg switch symbol text textPath title tspan use view").split())
_TAG = re.compile(r"</?([A-Za-z][^\t\n\f\r />]*)")
_START = re.compile(r"<[A-Za-z]")
_HEAD = re.compile(r"[\t\n\f\r ]*(?:<\?xml[^<>]*\?>[\t\n\f\r ]*)?(?=<svg[\t\n\f\r />])", re.I)
_SVG_TAG = re.compile(r"<(/?)svg(?=[\t\n\f\r />])", re.I)
_TEXT_ONLY = re.compile(r"<(title|desc)(?=[\t\n\f\r />])", re.I)  # HTML integration points: a tag inside is HTML
_ON = re.compile(r"(?<![\w-])on\w*\s*=")
_URL = re.compile(r"url\(")
_LOADS = ("@import", "@font-face", "image-set(", "image(", "src(", "src=")
_WS = "\t\n\f\r "  # the HTML tokenizer's whitespace


def _tag_at(s: str, i: int) -> list[tuple[str, str]] | None:
    """The attributes of the start tag at `s[i]` (a `<` and a letter), read as the HTML tokenizer reads them: names
    lowercased, values as written. None when the text ends inside the tag."""
    n, j = len(s), i + 1
    while j < n and s[j] not in _WS + "/>":
        j += 1
    attrs: list[tuple[str, str]] = []
    while True:
        while j < n and (s[j] in _WS or s[j] == "/"):  # before an attribute name; a `/` not before `>` is skipped
            j += 1
        if j >= n:
            return None
        if s[j] == ">":
            return attrs
        k = j + 1  # a name may start with `=`, and holds quotes and `<` as written
        while k < n and s[k] not in _WS + "/>=":
            k += 1
        name, j, value = s[j:k].lower(), k, ""
        while j < n and s[j] in _WS:
            j += 1
        if j < n and s[j] == "=":
            j += 1
            while j < n and s[j] in _WS:
                j += 1
            if j >= n:
                return None
            if s[j] in "\"'":
                end = s.find(s[j], j + 1)
                if end < 0:
                    return None
                value, j = s[j + 1 : end], end + 1
            elif s[j] != ">":
                k = j
                while k < n and s[k] not in _WS + ">":
                    k += 1
                value, j = s[j:k], k
        attrs.append((name, value))


def _root(svg: str) -> tuple[int, int] | None:
    """Where the one root `<svg>` starts and its matching `</svg>` ends, with nothing but space around them; None
    when the text is anything else."""
    head = _HEAD.match(svg)
    if not head:
        return None
    depth = 0
    for m in _SVG_TAG.finditer(svg, head.end()):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            end = svg.find(">", m.end())
            return (head.end(), end + 1) if end >= 0 and not svg[end + 1 :].strip(_WS) else None
    return None


def check_svg(svg: str) -> str | None:
    """Why this SVG may not go on the page, or None. It must be one `<svg>` whose root ID is `diagram-<n>`; each tag's
    attributes are read as a browser reads them, and every href and url( must point into `diagram-<n>`. Tag names are
    read as written; the rest is also read with character references decoded, as a browser reads attribute values and
    SVG style, so `&#x75;rl(` is `url(`."""
    shape = _root(svg)
    if not shape:
        return "the SVG is not one <svg> element"
    if "<!" in svg or "<?" in svg[shape[0] :]:  # in an SVG <style> they split a CSS word: u<!---->rl(
        return "the SVG holds a comment, CDATA or processing instruction"
    root = dict(reversed(_tag_at(svg, shape[0]) or []))  # the first of a repeated attribute wins
    number = re.fullmatch(r"diagram-(\d+)", html.unescape(root.get("id", "")))
    if not number:
        return "the SVG's root has no diagram-<n> ID"
    own = rf"#diagram-{number.group(1)}"
    href_ok = re.compile(rf"{own}(?:-|\Z)")  # a value is a URL: anything before the `#` makes it a relative one
    url_ok = re.compile(rf"[{_WS}]*[\"']?[{_WS}]*{own}(?=[-)\"'{_WS}])")  # CSS may quote and space the target
    raw = svg.lower()
    text = html.unescape(svg).lower()
    tags = [_tag_at(svg, m.start()) for m in _START.finditer(svg)]  # from every `<`: a decoy cannot hide a tag
    attrs = [a for t in tags if t is not None for a in t]
    if "<script" in raw or ":script" in raw:
        return "the SVG holds <script"
    if "<foreignobject" in raw:
        return "the SVG holds <foreignObject"
    if _ON.search(text) or any(name.startswith("on") for name, _ in attrs):
        return "the SVG holds an on…= attribute"
    # a link must point into the diagram both as written and decoded: an HTML parser reads a style raw, an SVG one decoded
    if any((name == "href" or name.endswith(":href")) and not all(href_ok.match(v.strip(_WS)) for v in (value, html.unescape(value)))
           for name, value in attrs):
        return "the SVG holds an href that is not #…"
    if any(not url_ok.match(t, m.end()) for t in (raw, text) for m in _URL.finditer(t)):
        return "the SVG holds a url( that is not url(#…)"
    tag = next((t for t in _TAG.findall(raw) if t not in _SVG_TAGS), None)
    if tag:
        return f"the SVG holds <{tag}>, which is not a drawing element"
    if None in tags:
        return "the SVG holds a tag that does not close"
    for m in _TEXT_ONLY.finditer(svg):
        start, close = svg.find(">", m.end()), re.compile(rf"</{m.group(1)}[\t\n\f\r />]", re.I).search(svg, m.end())
        if start < 0 or not close or _START.search(svg, start, close.start()):
            return f"the SVG holds a tag inside <{m.group(1).lower()}>, where HTML reads it"
    if "\\" in text:
        return "the SVG holds a backslash, which CSS can use to hide url( or @import"
    load = next((w for w in _LOADS if w in text), None)
    if load:
        return f"the SVG holds {load}"
    return None
