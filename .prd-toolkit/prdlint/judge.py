"""Judged cases (spec section 7): a model grader scores a built output against the case's rubric, every quote is checked
against the output, the median of N runs is the score, and every run is recorded."""
import hashlib
import json
import os
import re
import shutil
import statistics
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import hooks, packs
from .model import Prd, repo_root
from .rules.testcases import is_judged

SCHEMA: dict = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"item": {"type": "string"}, "pass": {"type": "boolean"}, "quote": {"type": "string"}},
                "required": ["item", "pass", "quote"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["items"],
    "additionalProperties": False,
}
DEFAULT_RUNS = 3
RECORD_DIR = ".prd-judge"
TEMPLATE = "judge/grader.md"
TIMEOUT = 600  # seconds per grader call
NO_CLAUDE = "install Claude Code or set a pack grader"
_WS = re.compile(r"\s+")
_PLACEHOLDER = re.compile(r"\{\{(RUBRIC|OUTPUT)\}\}")


class CannotJudge(Exception):
    """The case could not be judged (exit 2): `str(e)` says why, `.hint` what to do."""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.hint = hint


class BadAnswer(Exception):
    """One grader answer that is not the JSON the schema asks for, or names items that are not the rubric's."""


@dataclass
class Item:
    item: str
    passed: bool  # what the grader answered
    quote: str
    quote_found: bool  # the quote is in the output (whitespace collapsed); a pass without it counts as a fail

    @property
    def counts(self) -> bool:
        return self.passed and self.quote_found


@dataclass
class Run:
    items: list[Item]
    score: float


@dataclass
class Verdict:
    tid: str
    output: str
    sha256: str
    threshold: float
    model: str | None
    grader: str  # "default" or the pack's grader command
    runs: list[Run]
    median: float
    passed: bool

    def median_run(self) -> Run:
        """The run whose score is the median (the lower middle one when the count is even)."""
        return sorted(self.runs, key=lambda r: r.score)[(len(self.runs) - 1) // 2]

    def to_json(self) -> dict:
        return {
            "tid": self.tid, "output": self.output, "sha256": self.sha256, "threshold": self.threshold,
            "model": self.model, "grader": self.grader,
            "runs": [{"items": [{"item": i.item, "pass": i.passed, "quote": i.quote, "quote_found": i.quote_found}
                                for i in r.items], "score": r.score} for r in self.runs],
            "median": self.median, "verdict": "pass" if self.passed else "fail",
        }


def _collapse(s: str) -> str:
    return _WS.sub(" ", s)


def quote_found(quote: str, output: str) -> bool:
    """`quote` is a substring of `output` once every run of whitespace in both is one space (the plan's ruling); case,
    punctuation and quote marks stay exact. A quote that is empty or only whitespace is never found."""
    q = _collapse(quote).strip()
    return bool(q) and q in _collapse(output)


def default_argv(model: str | None) -> list[str]:
    """The default grader: headless `claude -p` with no tools, no MCP servers, no settings (so no plugins and no
    CLAUDE.md from them), no slash commands or skills, and no saved session. `$PRD_JUDGE_CLAUDE` replaces `claude`."""
    argv = [os.environ.get("PRD_JUDGE_CLAUDE") or "claude", "-p", "--output-format", "json",
            "--json-schema", json.dumps(SCHEMA, separators=(",", ":")), "--tools", "", "--strict-mcp-config",
            "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence"]
    return argv + (["--model", model] if model else [])


def template_path() -> Path:
    """grader.md: the plugin's templates/judge/, or the copy vendored beside the scripts (.prd-toolkit/judge/)."""
    return hooks.PLUGIN_ROOT / "templates" / TEMPLATE if hooks.is_plugin() else hooks.SCRIPTS / TEMPLATE


def prompt(rubric: list[str], output_text: str) -> str:
    """grader.md with the rubric (a JSON list) and the output text put in, in one pass: text in either is never
    read as a placeholder."""
    path = template_path()
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise CannotJudge(f"cannot read the grader prompt {path}: {e.strerror or e}", "reinstall prd-toolkit")
    values = {"RUBRIC": json.dumps(rubric, ensure_ascii=False, indent=2), "OUTPUT": output_text}
    return _PLACEHOLDER.sub(lambda m: values[m.group(1)], text)


def _first_line(s: str) -> str:
    return next((x.strip() for x in s.splitlines() if x.strip()), "")


def _failure(proc: subprocess.CompletedProcess) -> str:
    """Why a grader exited non-zero: its first stderr line, else the error an envelope on stdout carries."""
    line = _first_line(proc.stderr or "")
    if not line:
        try:
            env = json.loads(proc.stdout)
            line = _first_line(env.get("result") or "") if isinstance(env, dict) else ""
        except ValueError:
            line = ""
        line = line or _first_line(proc.stdout or "")
    return f"the grader exited {proc.returncode}: {line}" if line else f"the grader exited {proc.returncode}"


def _answer(stdout: str) -> object:
    """The answer in one grader's stdout: the object itself when it holds `items` (a pack grader), else the
    `claude -p` envelope's `structured_output`, else its `result` decoded as JSON."""
    try:
        obj = json.loads(stdout)
    except ValueError:
        raise BadAnswer(f"not JSON: {_first_line(stdout)[:120]!r}")
    if isinstance(obj, dict) and "items" in obj:
        return obj
    if not isinstance(obj, dict):
        raise BadAnswer("not a JSON object")
    if obj.get("is_error"):
        raise BadAnswer(f"the grader reported an error: {_first_line(str(obj.get('result') or obj.get('subtype')))}")
    if isinstance(obj.get("structured_output"), dict):
        return obj["structured_output"]
    if isinstance(obj.get("result"), str):
        try:
            return json.loads(obj["result"])
        except ValueError:
            raise BadAnswer(f"result is not JSON: {_first_line(obj['result'])[:120]!r}")
    raise BadAnswer("no structured_output or result in the envelope")


def _items(answer: object, rubric: list[str], output_text: str) -> list[Item]:
    """The answer as Items in rubric order; BadAnswer unless it grades each rubric item exactly once."""
    entries = answer.get("items") if isinstance(answer, dict) else None
    if not isinstance(entries, list):
        raise BadAnswer("items is not a list")
    key = {_collapse(r).strip(): r for r in rubric}
    got: dict[str, dict] = {}
    for e in entries:
        if not (isinstance(e, dict) and isinstance(e.get("item"), str) and isinstance(e.get("pass"), bool)
                and isinstance(e.get("quote"), str)):
            raise BadAnswer("an item is not {item: string, pass: boolean, quote: string}")
        k = _collapse(e["item"]).strip()
        if k not in key:
            raise BadAnswer(f"item not in the rubric: {e['item'][:120]!r}")
        if k in got:
            raise BadAnswer(f"item graded twice: {e['item'][:120]!r}")
        got[k] = e
    missing = [r for k, r in key.items() if k not in got]
    if missing:
        raise BadAnswer(f"rubric item not graded: {missing[0][:120]!r}")
    return [Item(r, got[k]["pass"], got[k]["quote"], quote_found(got[k]["quote"], output_text)) for k, r in key.items()]


def _call(argv: list[str], stdin_prompt: str | None) -> subprocess.CompletedProcess:
    """One grader process. The default grader (a prompt on stdin) runs in a new empty temporary directory, removed
    after; a pack grader runs where prd_judge.py runs, with no stdin."""
    cwd = tempfile.mkdtemp(prefix="prd-judge-") if stdin_prompt is not None else None
    hint = NO_CLAUDE if stdin_prompt is not None else "check the pack's grader: command"
    try:
        return subprocess.run(argv, input=stdin_prompt if stdin_prompt is not None else "", cwd=cwd,
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT)
    except FileNotFoundError:
        raise CannotJudge(f"{argv[0]}: not found", hint)
    except PermissionError:
        raise CannotJudge(f"{argv[0]}: not executable", hint)
    except subprocess.TimeoutExpired:
        raise CannotJudge(f"the grader did not answer in {TIMEOUT} s", "run it again, or check the grader by hand")
    finally:
        if cwd:
            shutil.rmtree(cwd, ignore_errors=True)


def grade_once(argv: list[str], rubric: list[str], output_text: str, stdin_prompt: bool) -> list[Item]:
    """One grading of the output: one call, one retry on a bad answer, then CannotJudge. A grader that exits non-zero
    ends the case at once (CannotJudge with its first stderr line), never a fail and never a pass."""
    text = prompt(rubric, output_text) if stdin_prompt else None
    why = ""
    for _ in range(2):
        proc = _call(argv, text)
        if proc.returncode != 0:
            raise CannotJudge(_failure(proc), "sign in to Claude Code (claude /login) or fix the grader, then rerun")
        try:
            return _items(_answer(proc.stdout), rubric, output_text)
        except BadAnswer as e:
            why = str(e)
    raise CannotJudge(f"the grader gave two bad answers; the last: {why}", "rerun; if it repeats, check the grader")


def _case(prd: Prd, tid: str):
    tc = next((t for t in prd.test_cases if t.id == tid), None)
    if tc is None:
        raise CannotJudge(f"no test case {tid} in {prd.root.as_posix()}/test-cases/", "check the T-id")
    if not is_judged(tc):
        raise CannotJudge(f"{tid} is not a judged case (its expect has no rubric:)", "judge only a case with rubric:")
    e = tc.data["expect"]
    lint = f"run prd_lint.py on {prd.root.as_posix()}"
    rubric, threshold, runs = e.get("rubric"), e.get("threshold"), e.get("runs", DEFAULT_RUNS)
    if not (isinstance(rubric, list) and rubric and all(isinstance(r, str) and r.strip() for r in rubric)):
        raise CannotJudge(f"{tid}: rubric must be a non-empty list of non-empty strings", lint)
    if len({_collapse(r).strip() for r in rubric}) != len(rubric):
        raise CannotJudge(f"{tid}: rubric repeats an item, so an answer cannot name each one", "make each item distinct")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 < threshold <= 1:
        raise CannotJudge(f"{tid}: threshold must be a number in (0, 1]", lint)
    if isinstance(runs, bool) or not isinstance(runs, int) or runs < 1:
        raise CannotJudge(f"{tid}: runs must be an integer of at least 1", lint)
    return tc, [str(r) for r in rubric], float(threshold), runs


def root_of(prd: Prd) -> Path:
    """The repository root: `<root>` of the toolkit's layout `<root>/docs/prd/<name>`, else git's top level."""
    p = prd.root
    if p.parent.name == "prd" and p.parent.parent.name == "docs":
        return p.parent.parent.parent
    return repo_root(p)


def default_record_dir(prd: Prd) -> Path:
    """`<first test root>/.prd-judge/` under the repository root; `<root>/.prd-judge/` when testing.md names none."""
    roots = prd.testing.harness.test_roots or []
    return root_of(prd) / (roots[0] if roots else ".") / RECORD_DIR


def _grader(prd: Prd, area: str):
    """The pack of `area` and its grader command (None for the default grader). A pack the PRD names that does not
    resolve ends the case; the unnamed service default that does not resolve means the default grader."""
    ref = packs.profile(prd, area)[0]
    try:
        pack = packs.resolve_cached(prd, ref)
    except packs._FAILURES as e:
        if ref.version is None:
            return None, None
        raise CannotJudge(str(e), "run prd_lint.py, then prd_hooks.py install")
    return pack, pack.grader


def judge(prd: Prd, tid: str, output: Path, runs: int | None, model: str | None, record_dir: Path | None) -> Verdict:
    """Judge case `tid` against `output`: `runs` gradings (default the case's runs:), the median score against the
    threshold, the record written to `record_dir/<tid>.json` (default `default_record_dir`). CannotJudge for exit 2."""
    tc, rubric, threshold, case_runs = _case(prd, tid)
    n = runs if runs is not None else case_runs
    if n < 1:
        raise CannotJudge("--runs must be at least 1")
    output = Path(output)
    try:
        raw = output.read_bytes()
    except OSError as e:
        raise CannotJudge(f"output file {output}: {e.strerror or e}", "build the output first, then judge it")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise CannotJudge(f"output file {output} is not UTF-8 text", "judge a text output")
    pack, command = _grader(prd, Path(tc.file).stem)
    scratch = None
    try:
        if command:
            scratch = tempfile.mkdtemp(prefix="prd-judge-")
            rubric_file = Path(scratch) / "rubric.json"
            rubric_file.write_text(json.dumps(rubric, ensure_ascii=False), encoding="utf-8")
            argv = packs.expand(command, pack) + ["--rubric", str(rubric_file), "--output", str(output.resolve())]
            stdin_prompt = False
        else:
            argv = default_argv(model)
            if shutil.which(argv[0]) is None:
                raise CannotJudge(f"{argv[0]}: not on PATH", NO_CLAUDE)
            stdin_prompt = True
        done = []
        for _ in range(n):
            items = grade_once(argv, rubric, text, stdin_prompt)
            done.append(Run(items, sum(i.counts for i in items) / len(items)))
    finally:
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)
    median = statistics.median(r.score for r in done)
    verdict = Verdict(tid, output.resolve().as_posix(), hashlib.sha256(raw).hexdigest(), threshold, model,
                      command or "default", done, median, median >= threshold)
    target = Path(record_dir) if record_dir is not None else default_record_dir(prd)
    target.mkdir(parents=True, exist_ok=True)
    (target / f"{tid}.json").write_text(json.dumps(verdict.to_json(), ensure_ascii=False, indent=2) + "\n",
                                        encoding="utf-8")
    return verdict
