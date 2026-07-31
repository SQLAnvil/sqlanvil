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
      start: toks[i].start,
      end,
    });
  }
  return found;
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
