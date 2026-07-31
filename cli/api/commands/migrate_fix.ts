import * as fs from "fs-extra";
import * as path from "path";

import {
  findConfigBlock,
  MigrationReport,
  parseSqlxConfig,
  renderReportMd,
  TodoClass,
} from "sa/cli/api/commands/migrate_dataform";
import {
  isWord,
  matchBracket,
  relationsIn,
  selectScopes,
  significant,
  splitOnCommas,
  Token,
  tokenize,
} from "sa/cli/api/commands/sql_lex";

/**
 * The graph-aware half of a Dataform migration, run AFTER `introspect`.
 *
 * `migrate-dataform` converts what it can from the source alone, but two conversions need
 * something it cannot have: the columns of the source tables. A converted declaration is written
 * with an empty `columnTypes` block and a TODO, because the columns live in the warehouse and are
 * only scaffolded once `scripts/introspect_all.sh` has run. The dominant `SELECT * EXCEPT` shape
 * in a real project — `select * except (_fivetran_deleted) from ${ref(source)}` — is therefore
 * impossible to expand at conversion time and trivial to expand afterwards.
 *
 * So the migration is three phases, not two: convert, introspect, fix. This is the third.
 *
 * It is re-runnable and reads the project's files directly rather than compiling, so it still
 * works on a project that does not yet compile — which, mid-migration, is the normal state.
 */

export interface MigrateFixOptions {
  projectDir: string;
  /** Report only unless set. */
  write?: boolean;
}

export interface UnresolvedSite {
  file: string;
  line: number;
  reason: string;
}

export interface MigrateFixResult {
  /** `SELECT * EXCEPT` sites expanded. */
  expanded: number;
  /** `GROUP BY ALL` clauses rewritten as ordinals. */
  groupByAll: number;
  files: string[];
  /** Sites left alone, with why — these belong in the migration report. */
  unresolved: UnresolvedSite[];
}

interface Action {
  /** Project-relative path. */
  file: string;
  type: string | null;
  name: string;
  schema: string | null;
  /** Declaration columns, in ordinal order. Empty until `introspect` has run. */
  columns: string[];
  /** SQL body — everything after the config block. */
  body: string;
  source: string;
  bodyOffset: number;
}

/** Columns of a declaration's `columnTypes { … }`, in the order written. */
function parseColumnTypes(config: string): string[] {
  const m = /\bcolumnTypes\s*:\s*\{/.exec(config);
  if (!m) return [];
  let depth = 0;
  let end = config.length;
  for (let i = m.index + m[0].length - 1; i < config.length; i++) {
    if (config[i] === "{") depth++;
    else if (config[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = config.slice(m.index + m[0].length, end);
  // Keys only, and not the ones inside the TODO comment the converter leaves behind.
  const withoutComments = body.replace(/\/\/[^\n]*/g, "");
  return [...withoutComments.matchAll(/(^|,)\s*([A-Za-z_]\w*)\s*:/g)].map(x => x[2]);
}

function loadActions(projectDir: string): Action[] {
  const actions: Action[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sqlx")) {
        const source = fs.readFileSync(full, "utf8");
        const span = findConfigBlock(source);
        const config = span ? source.slice(span.start, span.end) : "";
        const parsed = parseSqlxConfig(config);
        actions.push({
          file: path.relative(projectDir, full),
          type: parsed.type,
          name: parsed.name ?? path.basename(entry.name, ".sqlx"),
          schema: parsed.schema,
          columns: parseColumnTypes(config),
          body: span ? source.slice(span.end) : source,
          bodyOffset: span ? span.end : 0,
          source,
        });
      }
    }
  };
  walk(path.join(projectDir, "definitions"));
  return actions;
}

/** Output name of one select-list item, or null when it cannot be determined. */
function outputName(toks: Token[], start: number, end: number): string | null {
  const items = toks.slice(start, end);
  if (!items.length) return null;
  if (items.some(t => t.text === "*")) return null;
  const last = items[items.length - 1];
  if (isWord(items[items.length - 2], "as")) {
    return (last.value ?? last.text).replace(/^"|"$/g, "");
  }
  // A bare reference exposes its own (possibly qualified) trailing name.
  const bare = items.filter(t => t.text !== ".");
  if (bare.every(t => t.kind === "word" || t.kind === "quoted-ident")) {
    return (last.value ?? last.text).replace(/^"|"$/g, "");
  }
  return null;
}

class Resolver {
  private readonly byName = new Map<string, Action[]>();
  private readonly byPair = new Map<string, Action>();
  private readonly memo = new Map<string, string[] | null>();

  constructor(private readonly actions: Action[]) {
    for (const a of actions) {
      this.byName.set(a.name, [...(this.byName.get(a.name) ?? []), a]);
      if (a.schema) this.byPair.set(`${a.schema}.${a.name}`, a);
    }
  }

  /** Resolve a `${ref(...)}` token to an action, or a reason it cannot be resolved. */
  resolveRef(tok: Token): { action?: Action; reason?: string } {
    const args = [...tok.text.matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
    if (!args.length) return { reason: "ref with no literal arguments" };
    const name = args[args.length - 1];
    if (args.length >= 2) {
      const hit = this.byPair.get(`${args[args.length - 2]}.${name}`);
      return hit ? { action: hit } : { reason: `no action ${args[args.length - 2]}.${name}` };
    }
    const candidates = this.byName.get(name) ?? [];
    if (!candidates.length) return { reason: `unknown action ${name}` };
    if (candidates.length > 1) return { reason: `ambiguous action ${name}` };
    return { action: candidates[0] };
  }

  /**
   * Columns an action emits. A declaration answers from its introspected columnTypes; anything
   * else is derived from its own select list, recursively — which is why this must sweep to a
   * fixpoint at the call site: a star over a view is only knowable once that view names its own
   * columns.
   */
  columnsOf(action: Action, seen = new Set<string>()): string[] | null {
    if (action.columns.length) return action.columns;
    if (action.type === "declaration") return null; // introspect has not run for this one
    if (seen.has(action.file)) return null;
    const memo = this.memo.get(action.file);
    if (memo !== undefined && !seen.size) return memo;
    seen.add(action.file);
    const result = this.selectColumns(action.body, new Set(seen));
    if (!seen.size) this.memo.set(action.file, result);
    return result;
  }

  /** Output columns of the last top-level SELECT in a body. */
  selectColumns(sql: string, seen: Set<string>): string[] | null {
    const toks = significant(tokenize(sql));
    const scopes = selectScopes(toks);
    if (!scopes.length) return null;
    // The final top-level select is the one that shapes the action's output.
    const scope = scopes.reduce((best, s) => (s.select > best.select ? s : best), scopes[0]);
    const rels = scope.from === -1 ? [] : relationsIn(toks, scope.fromStart, scope.fromEnd);
    const names: string[] = [];
    for (const [s, e] of splitOnCommas(toks, scope.listStart, scope.listEnd)) {
      const item = toks.slice(s, e);
      const star = item.findIndex(t => t.text === "*");
      if (star === -1) {
        const n = outputName(toks, s, e);
        if (n === null) return null;
        names.push(n);
        continue;
      }
      // `t.*` binds to the alias; a bare `*` to the first relation.
      const qualifier =
        star >= 2 && item[star - 1]?.text === "." ? item[star - 2].text.toLowerCase() : null;
      const rel = qualifier ? rels.find(r => r.alias === qualifier) : rels[0];
      if (!rel) return null;
      const cols = this.relationColumns(rel.tokens, rel.subquery, seen);
      if (!cols) return null;
      const excluded = starExclusions(item, star);
      names.push(...cols.filter(c => !excluded.has(c.toLowerCase())));
    }
    return names.length ? names : null;
  }

  relationColumns(tokens: Token[], subquery: boolean, seen: Set<string>): string[] | null {
    if (subquery) {
      const inner = tokens
        .slice(1, -1)
        .map(t => t.text)
        .join(" ");
      return this.selectColumns(inner, seen);
    }
    const tmpl = tokens.find(t => t.kind === "template");
    if (tmpl) {
      const { action } = this.resolveRef(tmpl);
      return action ? this.columnsOf(action, seen) : null;
    }
    return null; // a CTE or bare name — resolved by the caller, which knows the file's CTEs
  }
}

/** Column names excluded by an `* EXCEPT (...)` modifier, lowercased. */
function starExclusions(item: Token[], star: number): Set<string> {
  const out = new Set<string>();
  if (!isWord(item[star + 1], "except")) return out;
  const open = star + 2;
  if (item[open]?.text !== "(") return out;
  const close = matchBracket(item, open);
  if (close < 0) return out;
  for (const [s, e] of splitOnCommas(item, open + 1, close)) {
    const t = item[s];
    if (t) out.add((t.value ?? t.text).replace(/^"|"$/g, "").toLowerCase());
  }
  return out;
}

/** A column emitted as written, quoted when PostgreSQL would otherwise fold it. */
function quoteIfNeeded(col: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(col) ? col : `"${col}"`;
}

const MARKER = "-- sqlanvil:star-except";

export async function migrateFix(opts: MigrateFixOptions): Promise<MigrateFixResult> {
  const result: MigrateFixResult = { expanded: 0, groupByAll: 0, files: [], unresolved: [] };
  const touched = new Set<string>();

  // Sweep to a fixpoint: expanding one view lets its consumers resolve, since a star over a view
  // is only knowable once that view names its own columns.
  for (let pass = 0; pass < 12; pass++) {
    const actions = loadActions(opts.projectDir);
    const resolver = new Resolver(actions);
    let changedThisPass = false;
    result.unresolved = [];

    for (const action of actions) {
      const source = action.source;
      const toks = significant(tokenize(source));
      const scopes = selectScopes(toks);
      const edits: Array<{ start: number; end: number; out: string }> = [];

      for (const scope of scopes) {
        const rels = scope.from === -1 ? [] : relationsIn(toks, scope.fromStart, scope.fromEnd);
        for (const [s, e] of splitOnCommas(toks, scope.listStart, scope.listEnd)) {
          const item = toks.slice(s, e);
          const star = item.findIndex(t => t.text === "*");
          if (star === -1 || !isWord(item[star + 1], "except")) continue;
          const line = source.slice(0, item[star].start).split("\n").length;

          const qualifier =
            star >= 2 && item[star - 1]?.text === "." ? item[star - 2].text.toLowerCase() : null;
          const rel = qualifier ? rels.find(r => r.alias === qualifier) : rels[0];
          if (!rel) {
            result.unresolved.push({
              file: action.file,
              line,
              reason: qualifier
                ? `no relation aliased "${qualifier}" in the FROM/JOIN chain`
                : "star has no FROM relation",
            });
            continue;
          }

          let cols = resolver.relationColumns(rel.tokens, rel.subquery, new Set());
          if (!cols) {
            // A bare name is a CTE in this file, or an action referenced without ${ref}.
            const bare = rel.tokens.map(t => t.text).join("");
            const cte = cteColumns(source, bare, resolver);
            cols = cte;
          }
          if (!cols) {
            const shown = rel.tokens.map(t => t.text).join("");
            result.unresolved.push({
              file: action.file,
              line,
              reason: rel.tokens.some(t => t.kind === "template")
                ? `columns of ${shown} are unknown — has introspect run for it?`
                : `cannot determine the columns of ${shown}`,
            });
            continue;
          }

          const excluded = starExclusions(item, star);
          const missing = [...excluded].filter(x => !cols!.some(c => c.toLowerCase() === x));
          if (missing.length) {
            result.unresolved.push({
              file: action.file,
              line,
              reason: `EXCEPT names ${missing.join(", ")}, which the source does not have`,
            });
            continue;
          }
          const keep = cols.filter(c => !excluded.has(c.toLowerCase()));
          if (!keep.length) {
            result.unresolved.push({
              file: action.file,
              line,
              reason: "the EXCEPT list removes every column",
            });
            continue;
          }

          const close = matchBracket(item, star + 2);
          const lineStart = source.lastIndexOf("\n", item[star].start) + 1;
          const indent = /^[ \t]*/.exec(source.slice(lineStart))![0] + "  ";
          const prefix = qualifier ? `${qualifier}.` : "";
          const body = keep.map(c => `${indent}${prefix}${quoteIfNeeded(c)}`).join(",\n");
          const marker =
            `${indent}${MARKER} ${prefix}* from ` +
            `${rel.tokens.map(t => t.text).join("")} minus (${[...excluded].join(", ")})`;
          edits.push({
            start: qualifier ? item[star - 2].start : item[star].start,
            end: item[close].end,
            out: `\n${marker}\n${body}`,
          });
        }
      }

      if (!edits.length) continue;
      let out = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        // Trim what the star left behind, so `select ` does not keep a trailing space before the
        // newline the expansion introduces.
        const head = out.slice(0, edit.start).replace(/[ \t]+$/, "");
        out = head + edit.out + out.slice(edit.end);
        result.expanded++;
      }
      changedThisPass = true;
      touched.add(action.file);
      if (opts.write) {
        fs.writeFileSync(path.join(opts.projectDir, action.file), out);
      } else {
        // Dry run: keep the in-memory result so the fixpoint still converges for reporting.
        action.source = out;
      }
    }
    if (!changedThisPass || !opts.write) break;
  }

  // GROUP BY ALL runs last: the ordinals depend on the select list, so any star has to have been
  // expanded first or the numbering is unknowable.
  for (const action of loadActions(opts.projectDir)) {
    const { text, expanded, unresolved } = expandGroupByAll(action.source);
    for (const u of unresolved) {
      result.unresolved.push({ file: action.file, line: u.line, reason: u.reason });
    }
    if (!expanded) continue;
    result.groupByAll += expanded;
    touched.add(action.file);
    if (opts.write) fs.writeFileSync(path.join(opts.projectDir, action.file), text);
  }

  result.files = [...touched].sort();
  if (opts.write) updateMigrationReport(opts.projectDir, result);
  return result;
}

/**
 * Fold this phase's outcome back into migration-report.{json,md}.
 *
 * The report is the handover document for the whole migration, not a record of what the converter
 * did on one afternoon. Leaving it to describe phase one means it keeps listing work that has
 * since been done and omits what replaced it — so whoever picks the project up, agent or person,
 * is reading a stale list. Both classes this phase owns are rewritten from what actually remains.
 */
function updateMigrationReport(projectDir: string, result: MigrateFixResult): void {
  const jsonPath = path.join(projectDir, "migration-report.json");
  if (!fs.existsSync(jsonPath)) return; // not a converted project, or the report was moved
  let report: MigrationReport;
  try {
    report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    return; // a corrupt report is not worth failing the fix over
  }
  if (!Array.isArray(report.todo)) return;

  const OWNED = new Set(["star-except", "group-by-all"]);
  const remaining = new Map<string, TodoClass>();
  for (const site of result.unresolved) {
    const id = /GROUP BY ALL/i.test(site.reason) || /star expands/i.test(site.reason)
      ? "group-by-all"
      : "star-except";
    const prior = report.todo.find(t => t.id === id);
    const entry =
      remaining.get(id) ??
      ({
        id,
        title: prior?.title ?? id,
        count: 0,
        severity: prior?.severity ?? "blocks-compile",
        // What is left is precisely what the tool could NOT decide, so it needs a person.
        owner: "needs-decision",
        postgres: prior?.postgres,
        why: site.reason,
        locations: [],
      } as TodoClass);
    entry.count++;
    const loc = entry.locations.find(l => l.file === site.file);
    if (loc) loc.lines.push(site.line);
    else entry.locations.push({ file: site.file, lines: [site.line] });
    remaining.set(id, entry);
  }

  report.todo = [...report.todo.filter(t => !OWNED.has(t.id)), ...remaining.values()];
  const applied = (n: number, id: string, title: string) => {
    if (!n) return;
    const seen = report.applied.find(a => a.id === id);
    if (seen) seen.count = n;
    else report.applied.push({ id, title, count: n });
  };
  applied(result.expanded, "star-except", "SELECT * EXCEPT expanded (migrate-fix)");
  applied(result.groupByAll, "group-by-all", "GROUP BY ALL rewritten as ordinals (migrate-fix)");

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(projectDir, "migration-report.md"), renderReportMd(report));
}

/**
 * PostgreSQL aggregate functions. Only used to decide what `GROUP BY ALL` should group BY, so
 * over-inclusion is harmless (an aggregate wrongly listed here is simply not grouped by, which
 * PostgreSQL would reject loudly) while omission produces a query that runs and returns the
 * wrong shape.
 */
const AGGREGATES = new Set([
  "count", "sum", "avg", "min", "max", "array_agg", "string_agg", "bool_and", "bool_or", "every",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp", "jsonb_agg",
  "json_agg", "jsonb_object_agg", "json_object_agg", "corr", "covar_pop", "covar_samp",
  "percentile_cont", "percentile_disc", "bit_and", "bit_or", "logical_and", "logical_or",
  "any_value", "countif",
]);

/**
 * Whether a select-list item belongs in the GROUP BY that replaces `GROUP BY ALL`.
 *
 * BigQuery groups by every item that is not an aggregate. Window functions have to be excluded
 * too, and for a stronger reason: PostgreSQL rejects them in GROUP BY outright. The two cannot be
 * told apart by name — `count(*)` is an aggregate and `count(*) over ()` is a window function —
 * so the decision is made by looking past the call's closing paren (and past any FILTER clause)
 * for an OVER.
 */
function isGroupable(item: Token[]): boolean {
  for (let i = 0; i < item.length; i++) {
    if (item[i].kind !== "word" || !AGGREGATES.has(item[i].text.toLowerCase())) continue;
    if (item[i + 1]?.text !== "(") continue;
    const close = matchBracket(item, i + 1);
    if (close < 0) return false;
    let after = close + 1;
    if (isWord(item[after], "filter") && item[after + 1]?.text === "(") {
      const filterClose = matchBracket(item, after + 1);
      if (filterClose > 0) after = filterClose + 1;
    }
    if (!isWord(item[after], "over")) return false; // a real aggregate
  }
  // A window function over a non-aggregate — row_number(), lag(), … — is equally ungroupable.
  return !item.some((t, i) => isWord(t, "over") && i > 0);
}

/**
 * Whether a select-list item IS a star — `*` or `t.*` — rather than merely containing one.
 *
 * `count(*)` contains a `*` and is not a star; so does `amount * 2`. Testing for the character
 * anywhere in the item reads every aggregate as a star, which silently declines to convert
 * exactly the queries that need it most.
 */
function isStarItem(item: Token[]): boolean {
  if (!item.length) return false;
  if (item[0].text === "*") return true;
  return item.length >= 3 && item[1].text === "." && item[2].text === "*";
}

/** Rewrite `GROUP BY ALL` as positional ordinals. */
function expandGroupByAll(source: string): {
  text: string;
  expanded: number;
  unresolved: Array<{ line: number; reason: string }>;
} {
  const toks = significant(tokenize(source));
  const scopes = selectScopes(toks);
  const edits: Array<{ start: number; end: number; out: string }> = [];
  const unresolved: Array<{ line: number; reason: string }> = [];

  for (let i = 0; i + 2 < toks.length; i++) {
    if (!isWord(toks[i], "group") || !isWord(toks[i + 1], "by") || !isWord(toks[i + 2], "all")) {
      continue;
    }
    const line = source.slice(0, toks[i].start).split("\n").length;
    // The enclosing SELECT is the nearest one before this clause.
    const scope = scopes.filter(s => s.select < i).pop();
    if (!scope) continue;

    const items = splitOnCommas(toks, scope.listStart, scope.listEnd);
    if (items.some(([s, e]) => isStarItem(toks.slice(s, e)))) {
      unresolved.push({
        line,
        reason:
          "GROUP BY ALL over a select list containing `*` — the ordinals depend on how many " +
          "columns the star expands to",
      });
      continue;
    }
    const ordinals = items
      .map(([s, e], idx) => (isGroupable(toks.slice(s, e)) ? idx + 1 : null))
      .filter((n): n is number => n !== null);
    if (!ordinals.length) {
      unresolved.push({ line, reason: "every select-list item is an aggregate" });
      continue;
    }
    edits.push({ start: toks[i + 2].start, end: toks[i + 2].end, out: ordinals.join(", ") });
  }

  let text = source;
  for (const e of edits.reverse()) {
    text = text.slice(0, e.start) + e.out + text.slice(e.end);
  }
  return { text, expanded: edits.length, unresolved };
}

/** Columns of a CTE defined in the same file, by name. */
function cteColumns(source: string, name: string, resolver: Resolver): string[] | null {
  const toks = significant(tokenize(source));
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind !== "word" || toks[i].text.toLowerCase() !== name.toLowerCase()) continue;
    if (!isWord(toks[i + 1], "as") || toks[i + 2]?.text !== "(") continue;
    const close = matchBracket(toks, i + 2);
    if (close < 0) return null;
    const inner = toks
      .slice(i + 3, close)
      .map(t => t.text)
      .join(" ");
    return resolver.selectColumns(inner, new Set());
  }
  return null;
}
