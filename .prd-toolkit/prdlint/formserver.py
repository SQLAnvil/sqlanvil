"""A local, token-guarded web page server: the parts the confirm form and the decision inbox share."""
import hmac
import json
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

MAX_BODY = 1024 * 1024
CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; "
       "base-uri 'none'; form-action 'none'")
_INCLUDE = re.compile(r"^ *<!-- include: ([^\s>]+) -->$")


class PageError(Exception):
    """A page that cannot be assembled."""


class Bad(Exception):
    """A request to answer with `status` and `{"error": why}`."""

    def __init__(self, status: int, why: str):
        super().__init__(why)
        self.status, self.why = status, why


def assemble(page: Path, include_dir: Path | None = None) -> str:
    """The page text with each line `<!-- include: NAME -->` replaced by the text of NAME; includes do not nest."""
    page = Path(page)
    base = Path(include_dir) if include_dir is not None else page.parent
    out = []
    with open(page, encoding="utf-8", newline="") as f:
        lines = f.read().splitlines(keepends=True)
    for line in lines:
        m = _INCLUDE.match(line.rstrip("\r\n"))
        if not m:
            out.append(line)
            continue
        try:
            out.append((base / m.group(1)).read_text(encoding="utf-8"))
        except OSError:
            raise PageError(f"include {m.group(1)} not found") from None
        if line.endswith(("\n", "\r")) and not out[-1].endswith("\n"):
            out[-1] += "\n"
    return "".join(out)


class Handler(BaseHTTPRequestHandler):
    """Checks the token on every request, answers `GET /ping`, then calls `route`. Subclasses implement `route`."""
    protocol_version = "HTTP/1.0"

    def setup(self) -> None:
        self.timeout = getattr(self.server, "request_timeout", 30)  # a stalled client frees its thread
        super().setup()

    def log_message(self, *args) -> None:  # no per-request log
        pass

    def send_bytes(self, status: int, body: bytes, ctype: str, csp: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if csp:
            self.send_header("Content-Security-Policy", CSP)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, obj: Any) -> None:
        self.send_bytes(status, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    def send_page(self, html: str) -> None:
        self.send_bytes(200, html.encode("utf-8"), "text/html; charset=utf-8", csp=True)

    def body_json(self) -> dict:
        raw = self.headers.get("Content-Length")
        try:
            n = int(raw) if raw is not None else -1
        except ValueError:
            n = -1
        if n < 0:
            raise Bad(400, "a POST needs a Content-Length")
        if n > MAX_BODY:
            left = n
            try:
                while left > 0:  # read it off the wire so the client sees the reply, not a reset
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    left -= len(chunk)
            except OSError:
                pass
            raise Bad(413, "request body is over 1 MB")
        try:
            data = self.rfile.read(n)
        except OSError:  # timed out waiting for the rest of the body
            raise Bad(408, "request timed out") from None
        if len(data) < n:
            raise Bad(400, "body is shorter than its Content-Length")
        try:
            obj = json.loads(data.decode("utf-8") or "{}")
        except ValueError:
            raise Bad(400, "body is not JSON") from None
        if not isinstance(obj, dict):
            raise Bad(400, "body must be a JSON object")
        return obj

    def authorized(self, query: dict, header: bool) -> bool:
        given = (query.get("token") or [""])[0]
        if not given and header:
            given = self.headers.get("X-Prd-Token", "")
        return hmac.compare_digest(given.encode("utf-8"), self.server.token.encode("utf-8"))

    def route(self, method: str, route: str, query: dict) -> None:
        raise Bad(404, "no such request")

    def handle_request(self, method: str) -> None:
        parts = urlsplit(self.path)
        query = parse_qs(parts.query)
        try:
            if not self.authorized(query, header=parts.path != "/"):
                raise Bad(403, "missing or wrong token")
            self.server.touch()  # only an authorized request keeps the server alive
            if method == "GET" and parts.path == "/ping":  # the liveness check every page and `live_inbox` use
                self.send_json(200, {"ok": True})
                return
            self.route(method, parts.path, query)
        except Bad as e:
            self.send_json(e.status, {"error": e.why})
        except (BrokenPipeError, ConnectionError):
            pass
        except Exception:  # noqa: BLE001 - nothing may reset the connection or print a traceback
            self.send_json(500, {"error": "internal error"})

    def do_GET(self) -> None:
        self.handle_request("GET")

    def do_POST(self) -> None:
        self.handle_request("POST")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128  # a burst of browser requests must not be reset

    def handle_error(self, request, client_address) -> None:  # never a traceback on the owner's terminal
        pass

    def __init__(self, address: tuple[str, int], handler: type[Handler], token: str, idle_minutes: float,
                 state: object, request_timeout: float = 30):
        self.token, self.state, self.request_timeout = token, state, request_timeout
        self.idle_seconds = idle_minutes * 60
        self.last = time.monotonic()
        self.end: str | None = None
        super().__init__(address, handler)

    def touch(self) -> None:
        self.last = time.monotonic()

    def finish(self) -> None:
        """End the run with exit 0 once the caller has replied."""
        self.end = "done"
        threading.Thread(target=self.shutdown, daemon=True).start()


def make_server(handler: type[Handler], port: int = 0, idle_minutes: float = 120, state: object = None,
                token: str | None = None, request_timeout: float = 30) -> tuple[Server, str]:
    """A server bound to 127.0.0.1 only, and its token (`secrets.token_urlsafe(24)` unless one is given).
    Raises OSError when `port` is in use."""
    token = token or secrets.token_urlsafe(24)
    return Server(("127.0.0.1", port), handler, token, idle_minutes, state, request_timeout), token


def run(server: Server) -> int:
    """Serve until `finish()` (0), Ctrl-C, SIGTERM (as KeyboardInterrupt) or the idle timeout (3)."""
    stop = threading.Event()

    def watch() -> None:
        while not stop.wait(0.05):
            if time.monotonic() - server.last > server.idle_seconds:
                server.end = "idle"
                server.shutdown()
                return

    server.last = time.monotonic()
    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    try:
        server.serve_forever(poll_interval=0.05)
    except KeyboardInterrupt:
        server.end = "interrupted"
    finally:
        stop.set()
        watcher.join(5)
    return 0 if server.end == "done" else 3


def write_json_atomic(path: Path, data: dict, mode: int | None = None) -> None:
    """Rewrite the whole file through a temporary file in the same folder, then os.replace."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f"{path.stem}.tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ensure_excluded(repo_root: Path, line: str) -> None:
    """Add `line` to the common git dir's info/exclude, once."""
    try:
        out = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=repo_root, capture_output=True, text=True,
                             encoding="utf-8", timeout=30, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return
    common = Path(out)
    if not common.is_absolute():
        common = Path(repo_root) / common
    exclude = common / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    text = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    if line in text.splitlines():
        return
    with exclude.open("a", encoding="utf-8") as f:
        f.write(("" if not text or text.endswith("\n") else "\n") + line + "\n")
