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
 * Analysis of BigQuery's `ARRAY(SELECT AS STRUCT …)` columns.
 *
 * An array of structs is not an exotic type — it is a one-to-many relationship, and relational
 * databases have always had a way to express that. Which way is right depends on what reads it,
 * so this works out the shape and the consumers first and recommends a strategy per site rather
 * than applying one blindly. Restructuring somebody's data model on a guess is the expensive
 * kind of wrong.
 */

export type StructStrategy = "collapse" | "child-table" | "jsonb";

export interface StructArraySite {
  /** File the producer lives in. */
  file: string;
  line: number;
  /** Column the array is exposed as. */
  column: string;
  /** Fields of the struct, in order. */
  fields: string[];
  /** The relation the inner SELECT reads. */
  source: string;
  /** The join key, from the inner query's correlation predicate. */
  correlation?: { sourceColumn: string; parentColumn: string };
  /** Byte range of the whole `ARRAY( … ) as name` item. */
  start: number;
  end: number;
  strategy: StructStrategy;
  /** Why that strategy, in terms a person can check. */
  rationale: string;
  /** Files that read this column, and whether every read is an UNNEST. */
  consumers: Array<{ file: string; unnestOnly: boolean }>;
}

/** Locate `ARRAY(SELECT AS STRUCT …)` items in one file. */
export function findStructArrays(file: string, source: string): Omit<
  StructArraySite,
  "strategy" | "rationale" | "consumers"
>[] {
  const toks = significant(tokenize(source));
  const found: Omit<StructArraySite, "strategy" | "rationale" | "consumers">[] = [];

  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], "array") || toks[i + 1]?.text !== "(") continue;
    const close = matchBracket(toks, i + 1);
    if (close < 0) continue;
    // `ARRAY(SELECT AS STRUCT …)` — the AS STRUCT is what makes it a struct array rather than an
    // array of scalars, which unnests to a plain column and needs none of this.
    if (!isWord(toks[i + 2], "select") || !isWord(toks[i + 3], "as") || !isWord(toks[i + 4], "struct")) {
      continue;
    }

    // Field names come from the inner select list; the relation from its FROM.
    const inner = toks.slice(i + 5, close);
    const innerSql = inner.map(t => t.text).join(" ");
    const innerToks = significant(tokenize(`select ${innerSql}`));
    const [scope] = selectScopes(innerToks);
    const fields: string[] = [];
    if (scope) {
      for (const [s, e] of splitOnCommas(innerToks, scope.listStart, scope.listEnd)) {
        const item = innerToks.slice(s, e);
        const last = item[item.length - 1];
        fields.push((last?.value ?? last?.text ?? "").replace(/^"|"$/g, ""));
      }
    }
    const rels = scope && scope.from !== -1 ? relationsIn(innerToks, scope.fromStart, scope.fromEnd) : [];
    const source_ = rels[0]?.tokens.map(t => t.text).join("") ?? "";

    // The correlation predicate is the join key: `where d.row_id = p.row_id` says this array is
    // the rows of `d` belonging to each row of `p`. Without it a child table has nothing to key
    // on, so it is worth digging out rather than leaving the reader to find it.
    let correlation: StructArraySite["correlation"];
    const whereIdx = innerToks.findIndex(t => isWord(t, "where"));
    if (whereIdx !== -1) {
      const eq = innerToks.findIndex((t, k) => k > whereIdx && t.text === "=");
      const left = innerToks.slice(Math.max(whereIdx + 1, eq - 3), eq);
      const right = innerToks.slice(eq + 1, eq + 4);
      const tail = (parts: Token[]) => {
        const words = parts.filter(t => t.kind === "word" || t.kind === "quoted-ident");
        return words.length ? (words[words.length - 1].value ?? words[words.length - 1].text) : "";
      };
      if (eq !== -1) correlation = { sourceColumn: tail(left), parentColumn: tail(right) };
    }

    // The column name follows the closing paren: `) as decimals`.
    let end = toks[close].end;
    let column = "";
    if (isWord(toks[close + 1], "as") && toks[close + 2]) {
      column = (toks[close + 2].value ?? toks[close + 2].text).replace(/^"|"$/g, "");
      end = toks[close + 2].end;
    }

    found.push({
      file,
      line: source.slice(0, toks[i].start).split("\n").length,
      column,
      fields,
      source: source_,
      correlation,
      start: toks[i].start,
      end,
    });
  }
  return found;
}

/**
 * The PostgreSQL to write for a site, ready to adapt.
 *
 * Concrete SQL rather than advice, because "consider a child table" leaves the reader to work out
 * the join key, the field list and what happens to the consumers — which is all knowable from the
 * construct and is exactly the part that takes the time.
 */
export function suggestedSql(site: StructArraySite): string {
  const fields = site.fields.length ? site.fields : ["…"];
  const key = site.correlation?.sourceColumn ?? "<parent key>";
  const parentKey = site.correlation?.parentColumn ?? "<parent key>";
  const src = site.source || "<source relation>";

  if (site.strategy === "collapse" && site.consumers.length) {
    // The consumers pivot the array back into columns, so they can pivot the source directly.
    const [k, v] = [fields[0] ?? "key", fields[1] ?? "value"];
    return [
      `-- Drop the \`${site.column}\` column from this action entirely, and have each reader`,
      `-- pivot ${src} directly. A consumer that today reads:`,
      `--`,
      `--   (select any_value(${v}) from unnest(${site.column}) where ${k} = '<name>')`,
      `--`,
      `-- becomes, selecting from ${src} grouped by ${parentKey}:`,
      ``,
      `max(${v}) filter (where ${k} = '<name>') as <name>`,
    ].join("\n");
  }

  if (site.strategy === "collapse") {
    return [
      `-- Nothing reads \`${site.column}\`. Confirm that, then delete the column — porting an`,
      `-- unused array costs a model change for no consumer.`,
    ].join("\n");
  }

  if (site.strategy === "child-table") {
    const cols = fields.map(f => `  ${f}`).join(",\n");
    return [
      `-- A new action holding the rows, keyed by the parent — this IS what the array was:`,
      ``,
      `config { type: "view" }`,
      ``,
      `select`,
      `  ${key} as ${parentKey},`,
      cols,
      `from \${ref("${src.replace(/^\$\{ref\(["']|["']\)\}$/g, "")}")}`,
      ``,
      `-- Then drop \`${site.column}\` from the parent and have readers join instead:`,
      `--   join \${ref("<this new action>")} c on c.${parentKey} = p.${parentKey}`,
    ].join("\n");
  }

  // jsonb — always available, and the reason it is the fallback: every reader changes too.
  const pairs = fields.map(f => `'${f}', ${f}`).join(", ");
  return [
    `-- Fallback. Keeps the shape but pushes a document model into a relational warehouse:`,
    ``,
    `(select jsonb_agg(jsonb_build_object(${pairs})) from ${src} …) as ${site.column}`,
    ``,
    `-- Readers then need jsonb_array_elements(...) and ->> instead of UNNEST.`,
  ].join("\n");
}

/**
 * Decide a strategy per site, from how the column is actually read.
 *
 * The order is deliberate. Collapse is best where it applies — an array that is only ever
 * UNNESTed straight back into a pivot is a round trip that exists because BigQuery makes nesting
 * cheap and joins expensive, neither of which is true here, so the array need not exist at all.
 * A child table is the honest general answer: indexable, queryable, comprehensible to any BI
 * tool. jsonb always works and is therefore the fallback, not the default — it pushes a document
 * model into a relational warehouse and every downstream reader pays for it.
 */
export function chooseStrategies(
  sites: Array<Omit<StructArraySite, "strategy" | "rationale" | "consumers">>,
  files: Array<{ file: string; source: string }>,
): StructArraySite[] {
  return sites.map(site => {
    const consumers: StructArraySite["consumers"] = [];
    for (const f of files) {
      if (f.file === site.file || !site.column) continue;
      const toks = significant(tokenize(f.source));
      const uses = toks
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.kind === "word" && t.text.toLowerCase() === site.column.toLowerCase());
      if (!uses.length) continue;
      // Every read is an UNNEST when each occurrence sits directly inside `unnest( … )`.
      const unnestOnly = uses.every(
        ({ i }) => isWord(toks[i - 2], "unnest") && toks[i - 1]?.text === "(",
      );
      consumers.push({ file: f.file, unnestOnly });
    }

    const readers = consumers.length;
    if (readers && consumers.every(c => c.unnestOnly)) {
      return {
        ...site,
        consumers,
        strategy: "collapse",
        rationale:
          `every read of \`${site.column}\` is an UNNEST (${readers} file(s)), so the array is a ` +
          `round trip — read ${site.source || "the source"} directly and drop the array`,
      };
    }
    if (!readers) {
      return {
        ...site,
        consumers,
        strategy: "collapse",
        rationale:
          `nothing in the project reads \`${site.column}\` — confirm it is unused, then drop it ` +
          `rather than porting it`,
      };
    }
    return {
      ...site,
      consumers,
      strategy: "child-table",
      rationale:
        `\`${site.column}\` is read in ${readers} file(s) and not only via UNNEST, so it needs to ` +
        `exist as a relation: a child table keyed by the parent, joined back`,
    };
  });
}
