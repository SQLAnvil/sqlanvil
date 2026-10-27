import {
  isWord,
  matchBracket,
  significant,
  splitOnCommas,
  Token,
  tokenize,
} from "sa/cli/api/commands/sql_lex";

/**
 * Find the BigQuery SQL that `migrate-dataform` neither rewrote nor flagged.
 *
 * The rewrites cover what has one honest PostgreSQL answer, and the lexical flag rules cover the
 * famous constructs (QUALIFY, STRUCT, EXPORT DATA). Everything else used to pass through without a
 * marker or a report entry: IFNULL, IF(), COUNTIF, DATETIME(x, 'tz'), JSON_VALUE, BQML, JS UDFs.
 * Porting a 1,500-file project showed what that costs — the residue was invisible until
 * `validate` failed on it one model at a time, and the constructs that become business decisions
 * (descope the BQML features? does this hash have to match?) never reached the report at all.
 *
 * Worse than the ones that fail are the ones that run. `REGEXP_REPLACE` replaces every match in
 * BigQuery and only the first in PostgreSQL; BigQuery's `CONCAT` returns NULL when any argument
 * is NULL, PostgreSQL's skips it; `LOG(x, base)` has its arguments the other way round. Each
 * compiles, runs, and returns different numbers, so each is reported as `changes-meaning`.
 *
 * This works on tokens, so a comment, a string, or a `${…}` template can never trigger it. The
 * caller blanks config and `js {}` blocks first. Nothing here rewrites: these are findings for the
 * report and an inline marker, including where the PostgreSQL form is known, because most of them
 * depend on a column type or an intent the SQL does not show.
 */

export type ResidueSeverity = "blocks-compile" | "fails-at-run" | "changes-meaning";
export type ResidueOwner = "mechanical" | "needs-decision";

export interface ResidueSite {
  /** Offset of the construct in the text passed in. */
  offset: number;
  /** Report class id: one of RESIDUE_CLASSES, or an existing converter class. */
  class: string;
  note: string;
}

/** Report metadata for the classes this detector introduces. */
export const RESIDUE_CLASSES: {
  [id: string]: {
    title: string;
    severity: ResidueSeverity;
    owner: ResidueOwner;
    postgres?: string;
    why?: string;
  };
} = {
  "regexp-replace-all": {
    title: "REGEXP_REPLACE replaces only the first match in PostgreSQL",
    severity: "changes-meaning",
    owner: "mechanical",
    postgres: "regexp_replace(x, re, rep, 'g')",
    why:
      "BigQuery replaces every match; without the 'g' flag PostgreSQL replaces the first and " +
      "leaves the rest. The query runs either way.",
  },
  "null-semantics": {
    title: "CONCAT / GREATEST / LEAST with a possibly-NULL argument",
    severity: "changes-meaning",
    owner: "needs-decision",
    postgres: "a || b (NULL if any part is NULL), or keep concat() if the NULLs were never meant",
    why:
      "BigQuery returns NULL when any argument is NULL; PostgreSQL ignores NULL arguments. " +
      "Whether the BigQuery NULL was deliberate is not in the SQL — a name that came out NULL " +
      "because one part was missing may be what a report relies on, or a bug nobody noticed.",
  },
  "log-args": {
    title: "LOG — base and argument order differ",
    severity: "changes-meaning",
    owner: "mechanical",
    postgres: "LOG(x) → ln(x); LOG(x, base) → log(base, x)",
    why:
      "BigQuery's one-argument LOG is the natural log, PostgreSQL's is base 10; with two " +
      "arguments BigQuery takes the value first, PostgreSQL the base. Every form runs.",
  },
  "extract-week": {
    title: "EXTRACT(WEEK …) numbers weeks differently",
    severity: "changes-meaning",
    owner: "mechanical",
    postgres:
      "floor((extract(doy from x) - extract(dow from x) + 6) / 7) for BigQuery's Sunday weeks",
    why:
      "BigQuery's WEEK counts weeks starting on Sunday from 0; PostgreSQL's week is the ISO week, " +
      "starting on Monday from 1. The two disagree on most dates.",
  },
  "trunc-order": {
    title: "DATE_TRUNC / TIMESTAMP_TRUNC in BigQuery argument order",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "date_trunc('unit', x)",
  },
  ifnull: {
    title: "IFNULL",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "coalesce(a, b)",
  },
  "if-function": {
    title: "IF(cond, a, b)",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "case when cond then a else b end",
  },
  countif: {
    title: "COUNTIF",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "count(*) filter (where cond)",
  },
  "logical-agg": {
    title: "LOGICAL_OR / LOGICAL_AND",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "bool_or / bool_and",
  },
  datetime: {
    title: "DATETIME / TIMESTAMP / TIME conversion functions",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "a cast (x::timestamp), or x AT TIME ZONE 'tz' for the time-zone form",
    why:
      "DATETIME(ts, 'tz') is `ts AT TIME ZONE 'tz'` only when ts is timestamptz. On a timestamp " +
      "WITHOUT time zone, AT TIME ZONE converts the other way — check the column's type before " +
      "porting each one.",
  },
  epoch: {
    title: "Epoch conversion functions",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "to_timestamp(s), to_timestamp(ms / 1000.0), extract(epoch from ts)",
  },
  json: {
    title: "BigQuery JSON functions",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "jsonb operators: j->>'a' for a scalar, j->'a' for an object or array",
    why:
      "PostgreSQL 17 also has JSON_VALUE / JSON_QUERY, but they take jsonb, so a text column " +
      "needs a ::jsonb cast first.",
  },
  "regexp-contains": {
    title: "REGEXP_CONTAINS",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "x ~ re",
  },
  "hash-bytes": {
    title: "TO_HEX / SHA* over bytes",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "md5(x) (already hex text); encode(sha256(convert_to(x, 'UTF8')), 'hex')",
  },
  "farm-fingerprint": {
    title: "FARM_FINGERPRINT",
    severity: "blocks-compile",
    owner: "needs-decision",
    postgres: "hashtextextended(x, 0), or a key on the string itself",
    why:
      "No PostgreSQL function produces the same values. If the hash is only a join key, any " +
      "stable hash (or the string itself) will do; if it is stored, exported, or compared with " +
      "values BigQuery produced, every one of them changes.",
  },
  "format-specifier": {
    title: "FORMAT with a printf specifier PostgreSQL lacks",
    severity: "fails-at-run",
    owner: "mechanical",
    postgres: "format() takes %s, %I and %L only — use to_char for numbers",
  },
  pivot: {
    title: "PIVOT / UNPIVOT",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "max(v) filter (where k = 'a') as a, … ; unpivot with a lateral VALUES list",
  },
  "information-schema": {
    title: "BigQuery INFORMATION_SCHEMA views",
    severity: "blocks-compile",
    owner: "needs-decision",
    postgres: "information_schema / pg_catalog — a different shape, per view",
    why:
      "Dataset- and region-qualified views (TABLE_OPTIONS, JOBS, TABLE_STORAGE) describe " +
      "BigQuery itself. Port the metadata model if something reads it, or descope it.",
  },
  "js-udf": {
    title: "JavaScript UDF",
    severity: "blocks-compile",
    owner: "needs-decision",
    postgres: "a PL/pgSQL or SQL function, or an extension that already does it (fuzzystrmatch)",
    why:
      "PostgreSQL does not run JavaScript functions (plv8 is not available on Supabase). Each " +
      "one is a rewrite in another language, so it is worth asking first whether its results are " +
      "still used.",
  },
  "sql-udf": {
    title: "BigQuery CREATE FUNCTION",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "CREATE FUNCTION … LANGUAGE sql AS $$ … $$, with PostgreSQL type names",
  },
  bqml: {
    title: "BigQuery ML (CREATE MODEL, ML.*, AI.*)",
    severity: "blocks-compile",
    owner: "needs-decision",
    postgres: "none in the warehouse — call the model from a script action or an edge function",
    why:
      "Model training and remote-model inference have no PostgreSQL counterpart. The question is " +
      "whether the feature moves, and to where, not how to translate the SQL.",
  },
  "bq-function": {
    title: "Other BigQuery-only functions",
    severity: "blocks-compile",
    owner: "mechanical",
    postgres: "per site — each marker names the PostgreSQL form",
  },
};

/** BigQuery functions with no PostgreSQL function of the same name and meaning, by class. */
const CALLS: { [name: string]: { class: string; note: string } } = {
  ifnull: { class: "ifnull", note: "IFNULL(a, b) → coalesce(a, b)" },
  countif: { class: "countif", note: "COUNTIF(cond) → count(*) filter (where cond)" },
  logical_or: { class: "logical-agg", note: "LOGICAL_OR → bool_or" },
  logical_and: { class: "logical-agg", note: "LOGICAL_AND → bool_and" },
  current_datetime: {
    class: "datetime",
    note: "CURRENT_DATETIME() → localtimestamp, or (current_timestamp at time zone 'tz')",
  },
  timestamp_seconds: { class: "epoch", note: "TIMESTAMP_SECONDS(s) → to_timestamp(s)" },
  timestamp_millis: { class: "epoch", note: "TIMESTAMP_MILLIS(ms) → to_timestamp(ms / 1000.0)" },
  timestamp_micros: { class: "epoch", note: "TIMESTAMP_MICROS(us) → to_timestamp(us / 1e6)" },
  unix_millis: {
    class: "epoch",
    note: "UNIX_MILLIS(ts) → (extract(epoch from ts) * 1000)::bigint",
  },
  unix_micros: { class: "epoch", note: "UNIX_MICROS(ts) → (extract(epoch from ts) * 1e6)::bigint" },
  unix_date: { class: "epoch", note: "UNIX_DATE(d) → (d - date '1970-01-01')" },
  date_from_unix_date: {
    class: "epoch",
    note: "DATE_FROM_UNIX_DATE(n) → date '1970-01-01' + n",
  },
  parse_datetime: {
    class: "parse-date",
    note: "PARSE_DATETIME → to_timestamp (different format tokens)",
  },
  parse_timestamp: {
    class: "parse-date",
    note: "PARSE_TIMESTAMP → to_timestamp (different format tokens)",
  },
  parse_time: {
    class: "parse-date",
    note: "PARSE_TIME → to_timestamp(…)::time (different format tokens)",
  },
  format_datetime: {
    class: "format-date",
    note: "FORMAT_DATETIME → to_char (different format tokens)",
  },
  format_time: { class: "format-date", note: "FORMAT_TIME → to_char (different format tokens)" },
  timestamp_diff: {
    class: "date-diff-unit",
    note: "TIMESTAMP_DIFF — PostgreSQL: extract(epoch from a - b) scaled to the unit",
  },
  datetime_diff: {
    class: "date-diff-unit",
    note: "DATETIME_DIFF — PostgreSQL: extract(epoch from a - b) scaled to the unit",
  },
  json_value: { class: "json", note: "JSON_VALUE(j, '$.a') → j::jsonb ->> 'a'" },
  json_extract_scalar: { class: "json", note: "JSON_EXTRACT_SCALAR(j, '$.a') → j::jsonb ->> 'a'" },
  json_query: { class: "json", note: "JSON_QUERY(j, '$.a') → j::jsonb -> 'a'" },
  json_extract: { class: "json", note: "JSON_EXTRACT(j, '$.a') → j::jsonb -> 'a'" },
  json_extract_array: {
    class: "json",
    note: "JSON_EXTRACT_ARRAY(j, '$.a') → jsonb_array_elements(j::jsonb -> 'a')",
  },
  json_query_array: {
    class: "json",
    note: "JSON_QUERY_ARRAY(j, '$.a') → jsonb_array_elements(j::jsonb -> 'a')",
  },
  json_extract_string_array: {
    class: "json",
    note: "JSON_EXTRACT_STRING_ARRAY → jsonb_array_elements_text(j::jsonb -> 'a')",
  },
  json_value_array: {
    class: "json",
    note: "JSON_VALUE_ARRAY → jsonb_array_elements_text(j::jsonb -> 'a')",
  },
  parse_json: { class: "json", note: "PARSE_JSON(s) → s::jsonb" },
  to_json_string: { class: "json", note: "TO_JSON_STRING(x) → to_jsonb(x)::text" },
  json_type: { class: "json", note: "JSON_TYPE(j) → jsonb_typeof(j)" },
  int64: { class: "json", note: "INT64(json) → (j #>> '{}')::bigint" },
  float64: { class: "json", note: "FLOAT64(json) → (j #>> '{}')::double precision" },
  lax_string: { class: "json", note: "LAX_STRING(j) → j #>> '{}'" },
  lax_int64: { class: "json", note: "LAX_INT64(j) → (j #>> '{}')::bigint" },
  lax_float64: { class: "json", note: "LAX_FLOAT64(j) → (j #>> '{}')::double precision" },
  lax_bool: { class: "json", note: "LAX_BOOL(j) → (j #>> '{}')::boolean" },
  regexp_contains: { class: "regexp-contains", note: "REGEXP_CONTAINS(x, re) → x ~ re" },
  farm_fingerprint: {
    class: "farm-fingerprint",
    note: "FARM_FINGERPRINT — no PostgreSQL equivalent; its values cannot be reproduced",
  },
  to_hex: { class: "hash-bytes", note: "TO_HEX(b) → encode(b, 'hex'); TO_HEX(MD5(x)) → md5(x)" },
  from_hex: { class: "hash-bytes", note: "FROM_HEX(s) → decode(s, 'hex')" },
  sha1: { class: "hash-bytes", note: "SHA1(x) → digest(x, 'sha1') (pgcrypto)" },
  sha256: { class: "hash-bytes", note: "SHA256(x) → sha256(convert_to(x, 'UTF8'))" },
  sha512: { class: "hash-bytes", note: "SHA512(x) → sha512(convert_to(x, 'UTF8'))" },
  to_base64: { class: "bq-function", note: "TO_BASE64(b) → encode(b, 'base64')" },
  from_base64: { class: "bq-function", note: "FROM_BASE64(s) → decode(s, 'base64')" },
  ends_with: { class: "bq-function", note: "ENDS_WITH(x, s) → right(x, length(s)) = s" },
  instr: { class: "bq-function", note: "INSTR(x, s) → strpos(x, s)" },
  byte_length: { class: "bq-function", note: "BYTE_LENGTH(x) → octet_length(x)" },
  code_points_to_string: {
    class: "bq-function",
    note: "CODE_POINTS_TO_STRING(a) → array_to_string(array(select chr(c) from unnest(a) c), '')",
  },
  to_code_points: {
    class: "bq-function",
    note: "TO_CODE_POINTS(s) → array(select ascii(c) from regexp_split_to_table(s, '') c)",
  },
  safe_convert_bytes_to_string: {
    class: "bq-function",
    note: "SAFE_CONVERT_BYTES_TO_STRING(b) → convert_from(b, 'UTF8')",
  },
  regexp_extract_all: {
    class: "bq-function",
    note: "REGEXP_EXTRACT_ALL(x, re) → array(select (regexp_matches(x, re, 'g'))[1])",
  },
  array_length: { class: "bq-function", note: "ARRAY_LENGTH(a) → cardinality(a)" },
  array_concat: { class: "bq-function", note: "ARRAY_CONCAT(a, b) → a || b" },
  array_reverse: {
    class: "bq-function",
    note: "ARRAY_REVERSE(a) → array(select x from unnest(a) with ordinality t(x, i) order by i desc)",
  },
  generate_array: {
    class: "bq-function",
    note: "GENERATE_ARRAY(a, b) → array(select generate_series(a, b))",
  },
  generate_date_array: {
    class: "bq-function",
    note: "GENERATE_DATE_ARRAY(a, b) → generate_series(a, b, interval '1 day')::date",
  },
  generate_timestamp_array: {
    class: "bq-function",
    note: "GENERATE_TIMESTAMP_ARRAY(a, b, i) → generate_series(a, b, i)",
  },
  last_day: {
    class: "bq-function",
    note: "LAST_DAY(d) → (date_trunc('month', d) + interval '1 month - 1 day')::date",
  },
  approx_count_distinct: {
    class: "bq-function",
    note: "APPROX_COUNT_DISTINCT(x) → count(distinct x)",
  },
  approx_quantiles: {
    class: "bq-function",
    note: "APPROX_QUANTILES → percentile_cont(array[…]) within group (order by x)",
  },
  approx_top_count: {
    class: "bq-function",
    note: "APPROX_TOP_COUNT → a GROUP BY … ORDER BY count(*) DESC LIMIT n subquery",
  },
  st_geogpoint: {
    class: "bq-function",
    note: "ST_GEOGPOINT(lng, lat) → ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography (PostGIS)",
  },
  st_centroid_agg: {
    class: "bq-function",
    note: "ST_CENTROID_AGG(g) → ST_Centroid(ST_Collect(g::geometry))::geography (PostGIS)",
  },
  soundex: { class: "bq-function", note: "SOUNDEX → soundex() from the fuzzystrmatch extension" },
  edit_distance: {
    class: "bq-function",
    note: "EDIT_DISTANCE → levenshtein() from the fuzzystrmatch extension",
  },
  error: { class: "bq-function", note: "ERROR(msg) → RAISE EXCEPTION in a PL/pgSQL function" },
  ieee_divide: { class: "bq-function", note: "IEEE_DIVIDE(a, b) → a::double precision / b" },
  safe_add: {
    class: "bq-function",
    note: "SAFE_ADD(a, b) → a + b (PostgreSQL raises on overflow)",
  },
  safe_subtract: { class: "bq-function", note: "SAFE_SUBTRACT(a, b) → a - b (raises on overflow)" },
  safe_multiply: { class: "bq-function", note: "SAFE_MULTIPLY(a, b) → a * b (raises on overflow)" },
  safe_negate: { class: "bq-function", note: "SAFE_NEGATE(a) → -a (raises on overflow)" },
  range_bucket: {
    class: "bq-function",
    note: "RANGE_BUCKET(x, a) → width_bucket(x, a) (an array of bounds, sorted)",
  },
  string: {
    class: "bq-function",
    note: "STRING(x) → x::text (with AT TIME ZONE for STRING(ts, tz))",
  },
};

/** Namespaces that exist only in BigQuery: `ML.PREDICT(…)`, `SAFE.PARSE_DATE(…)`, … */
const NAMESPACES: { [ns: string]: { class: string; note: (fn: string) => string } } = {
  ml: { class: "bqml", note: (fn) => `ML.${fn} — BigQuery ML has no PostgreSQL equivalent` },
  ai: {
    class: "bqml",
    note: (fn) => `AI.${fn} — BigQuery AI functions have no PostgreSQL equivalent`,
  },
  safe: {
    class: "bq-function",
    note: (fn) => `SAFE.${fn} — no SAFE. prefix in PostgreSQL; guard the input or catch the error`,
  },
  net: {
    class: "bq-function",
    note: (fn) => `NET.${fn} — no PostgreSQL equivalent (inet / regexp)`,
  },
  hll_count: {
    class: "bq-function",
    note: (fn) => `HLL_COUNT.${fn} — the hll extension, or count(distinct)`,
  },
  keys: { class: "bq-function", note: (fn) => `KEYS.${fn} — no PostgreSQL equivalent (pgcrypto)` },
  aead: { class: "bq-function", note: (fn) => `AEAD.${fn} — no PostgreSQL equivalent (pgcrypto)` },
};

/** BigQuery views under INFORMATION_SCHEMA that PostgreSQL's has no counterpart for. */
const BQ_ONLY_VIEWS =
  /^(jobs|jobs_by_\w+|table_storage\w*|table_options|partitions|column_field_paths|schemata_options|table_snapshots|streaming_timeline\w*|reservations\w*|capacity_commitment\w*|assignments\w*|object_privileges|search_indexes|vector_indexes|materialized_views)$/i;

const EXTRACT_PARTS: { [part: string]: { class: string; note: string } } = {
  week: {
    class: "extract-week",
    note: "EXTRACT(WEEK) — BigQuery weeks start on Sunday from 0; PostgreSQL's week is ISO",
  },
  isoweek: { class: "bq-function", note: "EXTRACT(ISOWEEK FROM x) → extract(week from x)" },
  dayofyear: { class: "bq-function", note: "EXTRACT(DAYOFYEAR FROM x) → extract(doy from x)" },
  date: { class: "datetime", note: "EXTRACT(DATE FROM ts) → ts::date" },
  time: { class: "datetime", note: "EXTRACT(TIME FROM ts) → ts::time" },
  datetime: { class: "datetime", note: "EXTRACT(DATETIME FROM ts) → ts::timestamp" },
};

/** A select-list-style argument that can never be NULL: a literal, or a coalesce(…) of one. */
function neverNull(arg: Token[]): boolean {
  if (arg.length === 1) {
    return arg[0].kind === "string" || arg[0].kind === "number";
  }
  if (isWord(arg[0], "coalesce", "ifnull") && arg[1]?.text === "(") {
    return matchBracket(arg, 1) === arg.length - 1;
  }
  return false;
}

/** True when the token at `i` sits in a type position (`AS timestamp(3)`, `::timestamp(3)`). */
function typePosition(toks: Token[], i: number): boolean {
  return isWord(toks[i - 1], "as") || (toks[i - 1]?.text === ":" && toks[i - 2]?.text === ":");
}

/** Whether token `i` starts a statement — the start of input, or after `;`, BEGIN, THEN, ELSE. */
function statementStart(toks: Token[], i: number): boolean {
  const prev = toks[i - 1];
  return !prev || prev.text === ";" || isWord(prev, "begin", "then", "else");
}

export function detectResidue(sql: string): ResidueSite[] {
  const toks = significant(tokenize(sql));
  const sites: ResidueSite[] = [];
  const add = (t: Token, cls: string, note: string) =>
    sites.push({ offset: t.start, class: cls, note });

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    // A backticked name the converter left alone, `proj.ds.INFORMATION_SCHEMA.TABLE_OPTIONS`.
    if (
      (t.kind === "backtick-ident" || t.kind === "quoted-ident") &&
      /(^|\.)information_schema\./i.test(t.value ?? t.text)
    ) {
      add(t, "information-schema", "BigQuery INFORMATION_SCHEMA view — no PostgreSQL counterpart");
      continue;
    }
    if (t.kind !== "word") {
      continue;
    }
    const w = t.text.toLowerCase();
    const next = toks[i + 1];

    if (w === "information_schema") {
      const view = toks[i + 1]?.text === "." ? toks[i + 2] : undefined;
      // PostgreSQL has information_schema too; only a qualified one (`ds.INFORMATION_SCHEMA`,
      // `${ds}.INFORMATION_SCHEMA`) or a BigQuery-only view is BigQuery's.
      if (toks[i - 1]?.text === "." || (view && BQ_ONLY_VIEWS.test(view.text))) {
        add(
          t,
          "information-schema",
          "BigQuery INFORMATION_SCHEMA view — no PostgreSQL counterpart",
        );
      }
      continue;
    }

    // CREATE [OR REPLACE] [TEMP] FUNCTION / MODEL
    if (w === "create") {
      let j = i + 1;
      if (isWord(toks[j], "or") && isWord(toks[j + 1], "replace")) {
        j += 2;
      }
      if (isWord(toks[j], "temp", "temporary")) {
        j++;
      }
      if (isWord(toks[j], "model")) {
        add(t, "bqml", "CREATE MODEL — BigQuery ML has no PostgreSQL equivalent");
      } else if (isWord(toks[j], "function")) {
        let k = j + 1;
        while (k < toks.length && toks[k].text !== ";" && !isWord(toks[k], "language")) {
          k++;
        }
        if (isWord(toks[k], "language") && isWord(toks[k + 1], "js", "javascript")) {
          add(t, "js-udf", "JavaScript UDF — PostgreSQL cannot run it; port or descope");
        } else {
          add(t, "sql-udf", "BigQuery CREATE FUNCTION → CREATE FUNCTION … LANGUAGE sql AS $$ … $$");
        }
      }
      continue;
    }

    // BigQuery scripting outside EXECUTE IMMEDIATE: DECLARE, and IF … END IF blocks.
    if (w === "declare" && statementStart(toks, i) && next?.kind === "word") {
      add(t, "scripting", "BigQuery scripting (DECLARE) — rewrite as a PL/pgSQL DO block");
      continue;
    }
    if (w === "end" && isWord(next, "if", "loop", "while", "for")) {
      add(
        t,
        "scripting",
        `BigQuery scripting (END ${next!.text.toUpperCase()}) — rewrite as a PL/pgSQL DO block`,
      );
      continue;
    }

    if ((w === "pivot" || w === "unpivot") && next?.text === "(") {
      add(t, "pivot", `${w.toUpperCase()} — conditional aggregates (max(v) filter (where …))`);
      continue;
    }

    if (next?.text !== "(") {
      continue;
    }
    const close = matchBracket(toks, i + 1);
    if (close < 0) {
      continue;
    }
    const args = splitOnCommas(toks, i + 2, close).map(([s, e]) => toks.slice(s, e));

    // Namespaced: ML.PREDICT(…), SAFE.PARSE_DATE(…). Any other `a.b(` is a schema-qualified
    // PostgreSQL function as far as this can tell.
    if (toks[i - 1]?.text === ".") {
      const ns = toks[i - 2];
      const meta = ns?.kind === "word" ? NAMESPACES[ns.text.toLowerCase()] : undefined;
      if (meta) {
        add(ns!, meta.class, meta.note(t.text.toUpperCase()));
      }
      continue;
    }

    const call = CALLS[w];
    if (call) {
      add(t, call.class, call.note);
      continue;
    }
    switch (w) {
      case "if":
        // IF(cond, a, b). A scripting `IF (select …) < (…) THEN` has no top-level commas, and is
        // reported at its END IF.
        if (args.length === 3) {
          add(t, "if-function", "IF(cond, a, b) → case when cond then a else b end");
        }
        break;
      case "datetime":
      case "timestamp":
      case "time":
        if (!typePosition(toks, i)) {
          const fn = w.toUpperCase();
          add(
            t,
            "datetime",
            args.length >= 2
              ? `${fn}(x, 'tz') → (x AT TIME ZONE 'tz') — check whether x is timestamptz`
              : `${fn}(x) → x::${w === "datetime" ? "timestamp" : w === "timestamp" ? "timestamptz" : "time"}`,
          );
        }
        break;
      case "date":
        if (args.length === 3) {
          add(t, "bq-function", "DATE(y, m, d) → make_date(y, m, d)");
        }
        break;
      case "date_trunc":
      case "timestamp_trunc":
      case "datetime_trunc":
      case "time_trunc":
        // PostgreSQL's date_trunc takes the unit first, as a string; BigQuery's takes it last.
        if (w !== "date_trunc" || (args.length === 2 && args[0][0]?.kind !== "string")) {
          add(t, "trunc-order", `${w.toUpperCase()}(x, unit) → date_trunc('unit', x)`);
        }
        break;
      case "regexp_replace":
        if (args.length === 3) {
          add(t, "regexp-replace-all", "REGEXP_REPLACE replaces every match in BigQuery → add 'g'");
        }
        break;
      case "concat":
      case "greatest":
      case "least":
        if (args.length > 1 && !args.every(neverNull)) {
          add(
            t,
            "null-semantics",
            `${w.toUpperCase()} — NULL if any argument is NULL in BigQuery; PostgreSQL ignores NULLs`,
          );
        }
        break;
      case "log":
        if (args.length === 2) {
          add(t, "log-args", "LOG(x, base) → log(base, x) — PostgreSQL takes the base first");
        } else if (args.length === 1) {
          add(
            t,
            "log-args",
            "LOG(x) is the natural log in BigQuery → ln(x); PostgreSQL's log(x) is base 10",
          );
        }
        break;
      case "format": {
        const fmt = args[0]?.length === 1 && args[0][0].kind === "string" ? args[0][0] : null;
        if (fmt && /%[^sIL%]/.test((fmt.value ?? fmt.text).replace(/%%/g, ""))) {
          add(t, "format-specifier", "FORMAT — PostgreSQL's format() has %s, %I and %L only");
        }
        break;
      }
      case "extract": {
        const part = toks[i + 2];
        const meta =
          part?.kind === "word" && (isWord(toks[i + 3], "from") || toks[i + 3]?.text === "(")
            ? EXTRACT_PARTS[part.text.toLowerCase()]
            : undefined;
        if (meta) {
          add(t, meta.class, meta.note);
        }
        break;
      }
      case "percentile_cont":
      case "percentile_disc":
        if (args.length === 2) {
          add(
            t,
            "bq-function",
            `${w.toUpperCase()}(x, p) OVER () → ${w}(p) within group (order by x)`,
          );
        }
        break;
    }
  }
  return sites;
}
