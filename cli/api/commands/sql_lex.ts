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
      while (i < sql.length && /\s/.test(sql[i])) i++;
      push("whitespace", start, i);
      continue;
    }

    // `${ ... }` — atomic. Brace-counted so a nested object literal inside the interpolation
    // does not end it early, and never inspected for SQL syntax.
    if (ch === "$" && sql[i + 1] === "{") {
      const start = i;
      let depth = 0;
      for (; i < sql.length; i++) {
        if (sql[i] === "{") depth++;
        else if (sql[i] === "}" && --depth === 0) {
          i++;
          break;
        }
      }
      push("template", start, i);
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      push("comment", start, i);
      continue;
    }

    // BigQuery accepts `#` line comments. Not preceded by a word character, so a `#` inside an
    // identifier-ish token is not mistaken for one.
    if (ch === "#") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      push("comment", start, i);
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(sql.length, i + 2);
      push("comment", start, i);
      continue;
    }

    // Raw-string prefix: r'…' / R"…". The prefix is part of the string token so a rewrite can
    // drop it as a unit.
    const rawPrefix = (ch === "r" || ch === "R") && (sql[i + 1] === "'" || sql[i + 1] === '"');
    if (ch === "'" || ch === '"' || rawPrefix) {
      const start = i;
      if (rawPrefix) i++;
      const quote = sql[i];
      i++;
      for (; i < sql.length; i++) {
        if (sql[i] !== quote) continue;
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
      while (i < sql.length && sql[i] !== "`") i++;
      i = Math.min(sql.length, i + 1);
      push("backtick-ident", start, i, sql.slice(start + 1, i - 1));
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[0-9._eE]/.test(sql[i])) i++;
      push("number", start, i);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      push("word", start, i);
      continue;
    }

    push("punct", i, i + 1);
    i++;
  }
  return tokens;
}

/** Tokens that carry meaning — everything except whitespace and comments. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter(t => t.kind !== "whitespace" && t.kind !== "comment");
}

/** Case-insensitive keyword test. */
export function isWord(t: Token | undefined, ...words: string[]): boolean {
  return (
    !!t && t.kind === "word" && words.some(w => t.text.toLowerCase() === w.toLowerCase())
  );
}

/**
 * The index of the token closing the bracket opened at `open`, or -1.
 * Works on the significant-token stream, so nesting inside strings or templates cannot confuse it.
 */
export function matchBracket(toks: Token[], open: number): number {
  const openCh = toks[open]?.text;
  const closeCh = openCh === "(" ? ")" : openCh === "[" ? "]" : null;
  if (!closeCh) return -1;
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i].text === openCh) depth++;
    else if (toks[i].text === closeCh && --depth === 0) return i;
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

const CLAUSE_ENDS = ["where", "group", "order", "having", "window", "limit", "qualify", "union", "intersect", "except"];

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
    if (!isWord(toks[i], "select")) continue;
    let depth = 0;
    let from = -1;
    let listEnd = -1;
    let end = toks.length;
    for (let j = i + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t.text === "(" || t.text === "[") depth++;
      else if (t.text === ")" || t.text === "]") {
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
          if (w === "except" && from === -1) continue;
          end = j;
          break;
        }
      } else if (depth === 0 && t.text === ";") {
        end = j;
        break;
      }
    }
    if (listEnd === -1) listEnd = end;
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
    if (t === "(" || t === "[") depth++;
    else if (t === ")" || t === "]") depth--;
    else if (t === "," && depth === 0) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  if (from < stop) out.push([from, stop]);
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
  "on", "using", "left", "right", "inner", "full", "cross", "outer", "join", "lateral", "natural",
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
      if (close < 0) break;
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
        if (toks[j].kind === "word" && JOIN_NOISE.has(toks[j].text.toLowerCase())) break;
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
    if (isWord(toks[k], "as")) k++;
    if (toks[k]?.kind === "word" && !JOIN_NOISE.has(toks[k].text.toLowerCase())) {
      alias = toks[k].text.toLowerCase();
      k++;
    } else {
      // No explicit alias: SQL exposes the relation under its own trailing name.
      const last = [...parts].reverse().find(p => p.kind === "word" || p.kind === "quoted-ident");
      if (last && !subquery) alias = (last.value ?? last.text).toLowerCase();
    }
    rels.push({ tokens: parts, alias, subquery });
    i = Math.max(k, j);
  }
  return rels;
}
