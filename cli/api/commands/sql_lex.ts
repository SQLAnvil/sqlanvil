/**
 * A tokenizer for the SQL that appears in .sqlx files.
 *
 * Not a parser and deliberately not one. The input is not valid SQL in any dialect — it is
 * BigQuery SQL with `${ref(...)}` and `${when(...)}` interpolations embedded mid-statement — so a
 * real grammar would have to substitute placeholders in, parse, and map positions back out, and
 * would silently convert nothing whenever a file failed to parse.
 *
 * What the conversions actually need is narrower than an AST: where a select list starts and
 * ends, which relations and aliases a FROM/JOIN chain introduces, and whether an identifier is a
 * reference or a definition. A lexer that knows strings, comments, quoting and template spans
 * answers all three, cannot fail closed on an unfamiliar construct, and keeps byte offsets so
 * rewrites splice back into the original text.
 *
 * Every hazard handled here was hit for real while porting an 800-action project by hand:
 *
 *   - a `${...}` span containing parens, quotes or commas that must never be read as SQL
 *   - `''` escaping inside a string, and one unpaired apostrophe swallowing the rest of a file
 *   - BigQuery's backtick identifiers and double-quoted STRINGS, whose meanings are the reverse
 *     of PostgreSQL's
 *   - `#` line comments, which BigQuery allows and PostgreSQL does not
 */

export type TokenKind =
  | "word"
  | "number"
  | "string"
  | "quoted-ident"
  | "backtick-ident"
  | "template"
  | "comment"
  | "punct"
  | "whitespace";

export interface Token {
  kind: TokenKind;
  /** Byte offsets into the original text, so a rewrite can splice by position. */
  start: number;
  end: number;
  /** The raw slice, quotes and all. */
  text: string;
  /** For quoted forms, the contents with the quoting removed. */
  value?: string;
}

/**
 * Split `sql` into tokens. Never throws: an unterminated string, comment or template runs to the
 * end of input and is returned as a single token, because a converter that gives up on a file is
 * worse than one that converts most of it and reports the rest.
 */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number, value?: string) =>
    tokens.push({ kind, start, end, text: sql.slice(start, end), value });

  while (i < sql.length) {
    const ch = sql[i];

    if (/\s/.test(ch)) {
      const start = i;
      while (i < sql.length && /\s/.test(sql[i])) {
        i++;
      }
      push("whitespace", start, i);
      continue;
    }

    // `${ ... }` — atomic, and never inspected for SQL syntax.
    if (ch === "$" && sql[i + 1] === "{") {
      const start = i;
      i = templateEnd(sql, i);
      push("template", start, i);
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      push("comment", start, i);
      continue;
    }

    // BigQuery accepts `#` line comments. Not preceded by a word character, so a `#` inside an
    // identifier-ish token is not mistaken for one.
    if (ch === "#") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") {
        i++;
      }
      push("comment", start, i);
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i = Math.min(sql.length, i + 2);
      push("comment", start, i);
      continue;
    }

    // Raw-string prefix: r'…' / R"…". The prefix is part of the string token so a rewrite can
    // drop it as a unit.
    const rawPrefix = (ch === "r" || ch === "R") && (sql[i + 1] === "'" || sql[i + 1] === '"');
    if (ch === "'" || ch === '"' || rawPrefix) {
      const start = i;
      if (rawPrefix) {
        i++;
      }
      const quote = sql[i];
      i++;
      for (; i < sql.length; i++) {
        // sqlx interpolates `${…}` before SQL is ever lexed, so an interpolation inside a literal
        // is still atomic: in `"${ref("x")}"` the inner quotes belong to the JavaScript, and
        // reading the first of them as the terminator splits one string into two.
        if (sql[i] === "$" && sql[i + 1] === "{") {
          i = templateEnd(sql, i) - 1;
          continue;
        }
        if (sql[i] !== quote) {
          continue;
        }
        if (quote === "'" && sql[i + 1] === "'") {
          i++; // '' is an escaped quote, not a terminator
          continue;
        }
        i++;
        break;
      }
      const raw = sql.slice(start, i);
      const inner = raw.slice(rawPrefix ? 2 : 1, raw.length - (raw.endsWith(quote) ? 1 : 0));
      // In BigQuery a double quote opens a STRING; in PostgreSQL it quotes an identifier. The
      // caller decides what to do about that — the lexer reports what BigQuery meant.
      push(quote === '"' ? "quoted-ident" : "string", start, i, inner);
      continue;
    }

    if (ch === "`") {
      const start = i;
      i++;
      while (i < sql.length && sql[i] !== "`") {
        i++;
      }
      i = Math.min(sql.length, i + 1);
      push("backtick-ident", start, i, sql.slice(start + 1, i - 1));
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[0-9._eE]/.test(sql[i])) {
        i++;
      }
      push("number", start, i);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) {
        i++;
      }
      push("word", start, i);
      continue;
    }

    push("punct", i, i + 1);
    i++;
  }
  return tokens;
}

/**
 * End offset (exclusive) of the `${…}` starting at `start`. Brace-counted so a nested object
 * literal inside the interpolation does not end it early; unterminated runs to the end of input.
 */
function templateEnd(sql: string, start: number): number {
  let depth = 0;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === "{") {
      depth++;
    } else if (sql[i] === "}" && --depth === 0) {
      return i + 1;
    }
  }
  return sql.length;
}

/**
 * Every `${…}` span in `sql`, including those inside string literals — which `tokenize` folds
 * into the enclosing string token. A rewrite that must leave JavaScript alone needs both kinds.
 */
export function interpolationSpans(sql: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const t of tokenize(sql)) {
    if (t.kind === "template") {
      spans.push({ start: t.start, end: t.end });
    } else if (t.kind === "string" || t.kind === "quoted-ident") {
      for (let i = t.start; i < t.end; i++) {
        if (sql[i] === "$" && sql[i + 1] === "{") {
          const end = Math.min(templateEnd(sql, i), t.end);
          spans.push({ start: i, end });
          i = end - 1;
        }
      }
    }
  }
  return spans;
}

/**
 * Comment spans in the JavaScript `js[start, end)`: `//` and block comments, and the SQL comments
 * (`--` and block) in the text of its template literals — which, in a Dataform project, is where
 * the SQL is. Strings, regex literals, templates and their `${…}` are followed, so a `//` in a
 * URL string or a `--` decrement is not taken for a comment. Like `tokenize`, never throws:
 * unterminated input runs to `end`.
 */
export function jsCommentSpans(
  js: string,
  start = 0,
  end = js.length,
): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  scanJs(js, start, end, false, spans);
  return spans;
}

const REGEX_AFTER_PUNCT = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await)$/;

/**
 * Scan JavaScript from `i`, collecting comment spans. Inside an interpolation, stops at the `}`
 * that closes it and returns its offset; otherwise returns `end`.
 */
function scanJs(
  js: string,
  i: number,
  end: number,
  inInterpolation: boolean,
  spans: Array<{ start: number; end: number }>,
): number {
  let depth = 0;
  let prev = ""; // last significant character: a `/` after an operand is division, not a regex
  while (i < end) {
    const ch = js[i];
    if (ch === "/" && js[i + 1] === "/") {
      const s = i;
      while (i < end && js[i] !== "\n") {
        i++;
      }
      spans.push({ start: s, end: i });
      continue;
    }
    if (ch === "/" && js[i + 1] === "*") {
      const close = js.indexOf("*/", i + 2);
      const e = close < 0 ? end : Math.min(end, close + 2);
      spans.push({ start: i, end: e });
      i = e;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipJsString(js, i, end);
      prev = ch;
      continue;
    }
    if (ch === "`") {
      i = scanJsTemplate(js, i, end, spans);
      prev = ch;
      continue;
    }
    if (
      ch === "/" &&
      (prev === "" ||
        REGEX_AFTER_PUNCT.test(prev) ||
        REGEX_AFTER_WORD.test(js.slice(Math.max(0, i - 12), i).trimEnd()))
    ) {
      i = skipJsRegex(js, i, end);
      prev = "/";
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (depth === 0 && inInterpolation) {
        return i;
      }
      depth--;
    }
    if (!/\s/.test(ch)) {
      prev = ch;
    }
    i++;
  }
  return end;
}

/** End of the '…' or "…" string at `i`: after its closing quote, or at an unescaped newline. */
function skipJsString(js: string, i: number, end: number): number {
  for (let j = i + 1; j < end; j++) {
    if (js[j] === "\\") {
      j++;
    } else if (js[j] === js[i]) {
      return j + 1;
    } else if (js[j] === "\n") {
      return j;
    }
  }
  return end;
}

/** End of the regex literal at `i`, flags included. A `/` inside `[…]` does not close it. */
function skipJsRegex(js: string, i: number, end: number): number {
  let inClass = false;
  for (let j = i + 1; j < end; j++) {
    const c = js[j];
    if (c === "\\") {
      j++;
    } else if (c === "\n") {
      return j;
    } else if (inClass) {
      inClass = c !== "]";
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      j++;
      while (j < end && /[a-z]/i.test(js[j])) {
        j++;
      }
      return j;
    }
  }
  return end;
}

/**
 * End of the template literal at `i`. Its `${…}` are scanned as JavaScript; its text is lexed as
 * SQL with each `${…}` replaced by same-length filler, so a quote around one (`'${x}'`) still
 * pairs. Only `--` and block comments count there: a `#` in template text is too often not SQL.
 */
function scanJsTemplate(
  js: string,
  i: number,
  end: number,
  spans: Array<{ start: number; end: number }>,
): number {
  const holes: Array<{ start: number; end: number }> = [];
  let j = i + 1;
  while (j < end && js[j] !== "`") {
    if (js[j] === "\\") {
      j += 2;
    } else if (js[j] === "$" && js[j + 1] === "{") {
      const close = scanJs(js, j + 2, end, true, spans);
      holes.push({ start: j, end: Math.min(end, close + 1) });
      j = close + 1;
    } else {
      j++;
    }
  }
  const textEnd = Math.min(j, end);
  const text = js
    .slice(i + 1, textEnd)
    .split("")
    .map((c, k) =>
      c !== "\n" && holes.some((h) => i + 1 + k >= h.start && i + 1 + k < h.end) ? "_" : c,
    )
    .join("");
  for (const t of tokenize(text)) {
    if (t.kind === "comment" && (t.text.startsWith("--") || t.text.startsWith("/*"))) {
      spans.push({ start: i + 1 + t.start, end: i + 1 + t.end });
    }
  }
  return textEnd < end ? textEnd + 1 : end;
}

/** Tokens that carry meaning — everything except whitespace and comments. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== "whitespace" && t.kind !== "comment");
}

/** Case-insensitive keyword test. */
export function isWord(t: Token | undefined, ...words: string[]): boolean {
  return !!t && t.kind === "word" && words.some((w) => t.text.toLowerCase() === w.toLowerCase());
}

/**
 * The index of the token closing the bracket opened at `open`, or -1.
 * Works on the significant-token stream, so nesting inside strings or templates cannot confuse it.
 */
export function matchBracket(toks: Token[], open: number): number {
  const openCh = toks[open]?.text;
  const closeCh = openCh === "(" ? ")" : openCh === "[" ? "]" : null;
  if (!closeCh) {
    return -1;
  }
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i].text === openCh) {
      depth++;
    } else if (toks[i].text === closeCh && --depth === 0) {
      return i;
    }
  }
  return -1;
}

export interface SelectScope {
  /** Token index of the SELECT keyword. */
  select: number;
  /** Token index range of the select list, [start, end). */
  listStart: number;
  listEnd: number;
  /** Token index of FROM, or -1 for a select with no FROM. */
  from: number;
  /** Token index range of the FROM/JOIN chain, [start, end). */
  fromStart: number;
  fromEnd: number;
}

const CLAUSE_ENDS = [
  "where",
  "group",
  "order",
  "having",
  "window",
  "limit",
  "qualify",
  "union",
  "intersect",
  "except",
];

/**
 * Every SELECT in the statement, with its select list and FROM chain delimited.
 *
 * Nesting is handled by bracket depth rather than by trying to identify subqueries: a SELECT
 * inside parentheses gets its own scope, and clause keywords only close a scope at the depth
 * that scope started at. That is what makes `select * except (a)` inside a derived table
 * resolvable without parsing the derived table itself.
 */
export function selectScopes(toks: Token[]): SelectScope[] {
  const scopes: SelectScope[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], "select")) {
      continue;
    }
    let depth = 0;
    let from = -1;
    let listEnd = -1;
    let end = toks.length;
    for (let j = i + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t.text === "(" || t.text === "[") {
        depth++;
      } else if (t.text === ")" || t.text === "]") {
        if (depth === 0) {
          end = j; // the scope's own parenthesis closed
          break;
        }
        depth--;
      } else if (depth === 0 && t.kind === "word") {
        const w = t.text.toLowerCase();
        if (w === "from" && from === -1) {
          from = j;
          listEnd = j;
        } else if (CLAUSE_ENDS.includes(w)) {
          // `except` closes a scope only as a set operator, never as `select * except (...)`,
          // which is a modifier on the star and sits INSIDE the list.
          if (w === "except" && from === -1) {
            continue;
          }
          end = j;
          break;
        }
      } else if (depth === 0 && t.text === ";") {
        end = j;
        break;
      }
    }
    if (listEnd === -1) {
      listEnd = end;
    }
    scopes.push({
      select: i,
      listStart: i + 1,
      listEnd,
      from,
      fromStart: from === -1 ? -1 : from + 1,
      fromEnd: from === -1 ? -1 : end,
    });
  }
  return scopes;
}

/** Split a token range on top-level commas, returning index ranges. */
export function splitOnCommas(toks: Token[], start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  const stop = Math.min(end, toks.length);
  let from = Math.max(0, start);
  for (let i = from; i < stop; i++) {
    const t = toks[i].text;
    if (t === "(" || t === "[") {
      depth++;
    } else if (t === ")" || t === "]") {
      depth--;
    } else if (t === "," && depth === 0) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  if (from < stop) {
    out.push([from, stop]);
  }
  return out;
}

export interface Relation {
  /** The relation as written: a template ref, a quoted or bare name, or "(" for a subquery. */
  tokens: Token[];
  /** Lowercased alias, explicit or derived from the trailing name part. */
  alias?: string;
  /** True when the relation is a parenthesised subquery. */
  subquery: boolean;
}

const JOIN_NOISE = new Set([
  "on",
  "using",
  "left",
  "right",
  "inner",
  "full",
  "cross",
  "outer",
  "join",
  "lateral",
  "natural",
]);

/**
 * The relations a FROM/JOIN chain introduces, with their aliases.
 *
 * Aliases matter more than the relation names for the conversions that use this: knowing that
 * `t` binds to a particular declaration is what makes `t.*` expandable and what stops a column
 * named `R` being confused with a table aliased `r`.
 */
export function relationsIn(toks: Token[], start: number, end: number): Relation[] {
  const rels: Relation[] = [];
  let i = start;
  while (i < end) {
    // Advance to the start of a relation: the beginning of the chain, or after FROM/JOIN.
    if (i > start && !isWord(toks[i - 1], "from", "join")) {
      i++;
      continue;
    }
    let j = i;
    let subquery = false;
    const parts: Token[] = [];
    if (toks[j]?.text === "(") {
      const close = matchBracket(toks, j);
      if (close < 0) {
        break;
      }
      subquery = true;
      parts.push(...toks.slice(j, close + 1));
      j = close + 1;
    } else {
      // A dotted or templated name: ${ref(...)}, schema.table, "quoted".parts
      while (
        j < end &&
        (toks[j].kind === "template" ||
          toks[j].kind === "word" ||
          toks[j].kind === "quoted-ident" ||
          toks[j].kind === "backtick-ident" ||
          toks[j].text === ".")
      ) {
        // `as` ends the name and begins the alias — without this the two run together and the
        // relation reads as `orders` + `as` + `o`.
        if (isWord(toks[j], "as")) {
          break;
        }
        if (toks[j].kind === "word" && JOIN_NOISE.has(toks[j].text.toLowerCase())) {
          break;
        }
        parts.push(toks[j]);
        j++;
      }
    }
    if (!parts.length) {
      i++;
      continue;
    }
    let alias: string | undefined;
    let k = j;
    if (isWord(toks[k], "as")) {
      k++;
    }
    if (toks[k]?.kind === "word" && !JOIN_NOISE.has(toks[k].text.toLowerCase())) {
      alias = toks[k].text.toLowerCase();
      k++;
    } else {
      // No explicit alias: SQL exposes the relation under its own trailing name.
      const last = [...parts].reverse().find((p) => p.kind === "word" || p.kind === "quoted-ident");
      if (last && !subquery) {
        alias = (last.value ?? last.text).toLowerCase();
      }
    }
    rels.push({ tokens: parts, alias, subquery });
    i = Math.max(k, j);
  }
  return rels;
}
