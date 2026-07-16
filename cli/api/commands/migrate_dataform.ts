import * as fs from "fs";
import * as path from "path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

import { agentsMdContents, claudeMdBridgeContents } from "sa/cli/api/commands/agents_md";
import { version as sqlanvilVersion } from "sa/core/version";

/**
 * `sqlanvil migrate-dataform <srcDir> --out <dir>` — the OSS converter core of the migration
 * wizard (spec: new-project wizard §3): a pure directory→directory transform. A Dataform/
 * BigQuery project goes in; a sqlanvil-on-Postgres project plus a machine-readable migration
 * report come out.
 *
 * HARD GUARANTEE: the source directory is READ-ONLY. Every write goes through `writeOut`,
 * which refuses any path outside the output directory; the source is only ever read.
 *
 * Honest conversion policy (flag, don't guess):
 *   - Config/structure conversion is mechanical (workflow settings, declaration rewrites,
 *     bigquery-block neutralization).
 *   - SQL gets best-effort LEXICAL rewrites only where they're safe (SAFE_CAST → CAST,
 *     CURRENT_DATE() → CURRENT_DATE, `ident` → "ident", dataform.projectConfig →
 *     sqlanvil.projectConfig); everything else becomes an inline `SQLANVIL-MIGRATE:` marker +
 *     a report entry. `sqlanvil validate` is the completion loop.
 *   - Classification is by ACTION TYPE: `type: "declaration"` schemas are SOURCES (data stays
 *     in BigQuery; only the declaration config is rewritten to a named runner-extract
 *     connection); materializing actions are TARGETS (they move to Postgres and get the
 *     dialect pass).
 */

// ---------------------------------------------------------------------------------------------
// Options / report shapes
// ---------------------------------------------------------------------------------------------

export interface MigrateDataformOptions {
  srcDir: string;
  outDir: string;
  /** Pinned in the generated workflow_settings.yaml. Defaults to the running core version. */
  coreVersion?: string;
  /**
   * Where the CONVERTED project runs. `supabase` (default) / `postgres` = move off BigQuery:
   * declarations become named runner-extract connections and target SQL gets the dialect
   * pass. `bigquery` = tooling swap only — the project keeps running on the SAME warehouse,
   * so SQL bodies, `bigquery: {}` blocks, and declarations pass through untouched (only the
   * compile-global rename and the settings-file conversion apply).
   */
  targetWarehouse?: "supabase" | "postgres" | "bigquery";
}

export interface SourceConnection {
  name: string;
  project: string;
  datasets: string[];
  declarationCount: number;
  introspectExample: string;
}

export interface FileFinding {
  line: number;
  kind: "rewrite" | "flag";
  note: string;
}

export interface ConvertedFile {
  file: string;
  action: "declaration" | "target" | "copied" | "includes" | "generated";
  type?: string;
  status: "clean" | "rewritten" | "flagged";
  findings: FileFinding[];
  connection?: string;
}

export interface MigrationReport {
  targetWarehouse: string;
  generator: string;
  sourceDir: string;
  sourceConfig: Record<string, unknown>;
  inventory: { sqlxFiles: number; jsFiles: number; byType: Record<string, number> };
  connections: SourceConnection[];
  /** Schemas that appear on BOTH declarations and materializing actions — triage carefully. */
  overlappingSchemas: string[];
  files: ConvertedFile[];
  skippedForSafety: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------------------------
// Read-only enforcement + fs helpers
// ---------------------------------------------------------------------------------------------

function containsPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

class OutWriter {
  constructor(private readonly outDir: string) {}
  public write(relPath: string, contents: string | Buffer) {
    const full = path.resolve(this.outDir, relPath);
    if (!containsPath(path.resolve(this.outDir), full)) {
      throw new Error(`Refusing to write outside the output directory: ${relPath}`);
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
}

/** Files never copied into the migrated repo — credentials and stale build artifacts. */
const SAFETY_SKIP = [
  /^\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.df-credentials[^/]*\.json$/,
  /service_account[^/]*\.json$/i,
  /(^|\/)\.env([^/]*)$/,
  /\.pem$/,
  /(^|\/)compile_output\.json$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)target(\/|$)/,
];

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (SAFETY_SKIP.some(re => re.test(relPath) || re.test(relPath + "/"))) {
        skippedForSafety.add(relPath);
        continue;
      }
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk("");
  return out;
}

// Collected during a run (module-level for the walker; reset per invocation).
let skippedForSafety: Set<string>;

// ---------------------------------------------------------------------------------------------
// sqlx config-block parsing (lightweight — declarations and config extraction only)
// ---------------------------------------------------------------------------------------------

interface ConfigSpan {
  start: number; // index of "config"
  open: number; // index of "{"
  end: number; // index AFTER the closing "}"
  body: string; // between braces
}

/** Locate the sqlx `config { ... }` block with a quote-aware brace counter. */
export function findConfigBlock(source: string): ConfigSpan | null {
  const m = /(^|\n)\s*config\s*\{/.exec(source);
  if (!m) return null;
  const open = source.indexOf("{", m.index + m[0].indexOf("config"));
  let depth = 0;
  let inString: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return {
          start: m.index + (m[1] ? m[1].length : 0),
          open,
          end: i + 1,
          body: source.slice(open + 1, i),
        };
      }
    }
  }
  return null;
}

/** Line indexes (0-based) covered by sqlx `js { ... }` blocks — no inline markers there. */
export function jsBlockLines(source: string): Set<number> {
  const lines = new Set<number>();
  const re = /(^|\n)\s*js\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const open = source.indexOf("{", m.index + m[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) end = source.length - 1;
    const startLine = source.slice(0, m.index + (m[1] ? m[1].length : 0)).split("\n").length - 1;
    const endLine = source.slice(0, end).split("\n").length - 1;
    for (let l = startLine; l <= endLine; l++) lines.add(l);
  }
  return lines;
}

const str = (field: string, body: string): string | null => {
  const re = new RegExp(`${field}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`);
  const m = re.exec(body);
  return m ? m[1] : null;
};

export interface ParsedSqlxConfig {
  type: string | null;
  schema: string | null;
  database: string | null; // literal, or "<defaultDatabase>" for the projectConfig expression
  name: string | null;
  description: string | null;
}

export function parseSqlxConfig(body: string): ParsedSqlxConfig {
  let database = str("database", body);
  if (!database && /database\s*:\s*(dataform|sqlanvil)\.projectConfig\.defaultDatabase/.test(body)) {
    database = "<defaultDatabase>";
  }
  return {
    type: str("type", body),
    schema: str("schema", body),
    database,
    name: str("name", body),
    description: str("description", body),
  };
}

// ---------------------------------------------------------------------------------------------
// Lexical SQL / config rules
// ---------------------------------------------------------------------------------------------

interface Rule {
  pattern: RegExp;
  replacement?: string;
  kind: "rewrite" | "flag";
  note: string;
}

/** Applied everywhere (config, sql, js): the compile-global rename. */
const GLOBAL_RULES: Rule[] = [
  {
    pattern: /\bdataform\.projectConfig\b/g,
    replacement: "sqlanvil.projectConfig",
    kind: "rewrite",
    note: "dataform.projectConfig → sqlanvil.projectConfig (compile global renamed)",
  },
];

/** SQL-body rules for TARGET files (materializing actions). Order matters. */
const SQL_RULES: Rule[] = [
  {
    pattern: /\bSAFE_CAST\s*\(/g,
    replacement: "CAST(",
    kind: "rewrite",
    note: "SAFE_CAST → CAST — Postgres CAST raises on bad input; verify the data or guard it",
  },
  {
    pattern: /\bCURRENT_DATE\s*\(\s*\)/g,
    replacement: "CURRENT_DATE",
    kind: "rewrite",
    note: "CURRENT_DATE() → CURRENT_DATE",
  },
  {
    pattern: /\bCURRENT_DATE\s*\(\s*['"]/g,
    kind: "flag",
    note: "CURRENT_DATE('<tz>') — Postgres: (CURRENT_TIMESTAMP AT TIME ZONE '<tz>')::date",
  },
  {
    pattern: /\bSAFE_DIVIDE\s*\(/g,
    kind: "flag",
    note: "SAFE_DIVIDE(a, b) — Postgres: a / NULLIF(b, 0)",
  },
  {
    pattern: /\bSAFE_OFFSET\s*\(/g,
    kind: "flag",
    note: "array[SAFE_OFFSET(n)] — Postgres arrays are 1-based; use (split_part / arr[n+1])",
  },
  { pattern: /\bQUALIFY\b/gi, kind: "flag", note: "QUALIFY — rewrite as a subquery/CTE filter on the window function" },
  { pattern: /\bUNNEST\s*\(/g, kind: "flag", note: "UNNEST — Postgres unnest() works on arrays only (no STRUCT arrays); verify semantics" },
  { pattern: /\bSTRUCT\s*[(<]/g, kind: "flag", note: "STRUCT — no Postgres equivalent; consider jsonb or a composite type" },
  { pattern: /\bARRAY\s*</g, kind: "flag", note: "ARRAY<T> type syntax — Postgres uses T[]" },
  { pattern: /\bFORMAT_DATE\s*\(/g, kind: "flag", note: "FORMAT_DATE → TO_CHAR (different format tokens)" },
  { pattern: /\bPARSE_DATE\s*\(/g, kind: "flag", note: "PARSE_DATE → TO_DATE (different format tokens)" },
  { pattern: /\bFORMAT_TIMESTAMP\s*\(/g, kind: "flag", note: "FORMAT_TIMESTAMP → TO_CHAR (different format tokens)" },
  {
    pattern: /\b(DATE_ADD|DATE_SUB|TIMESTAMP_ADD|TIMESTAMP_SUB|DATETIME_ADD|DATETIME_SUB)\s*\(/g,
    kind: "flag",
    note: "BigQuery date arithmetic — Postgres uses interval arithmetic (x + INTERVAL '1 day')",
  },
  { pattern: /\bDATE_DIFF\s*\(/g, kind: "flag", note: "DATE_DIFF — Postgres: subtraction / EXTRACT(EPOCH FROM ...) depending on the part" },
  { pattern: /_PARTITIONTIME|_PARTITIONDATE|_TABLE_SUFFIX/g, kind: "flag", note: "BigQuery pseudo-column has no Postgres equivalent" },
  { pattern: /\bEXPORT\s+DATA\b/gi, kind: "flag", note: "EXPORT DATA — use a sqlanvil `type: \"export\"` action instead" },
  { pattern: /\bEXECUTE\s+IMMEDIATE\b/gi, kind: "flag", note: "BigQuery scripting (EXECUTE IMMEDIATE) — rewrite as a PL/pgSQL DO block or operations" },
  { pattern: /\bGENERATE_UUID\s*\(\s*\)/g, kind: "flag", note: "GENERATE_UUID() → gen_random_uuid()" },
  {
    pattern: /`[A-Za-z0-9_-]+\.[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+`/g,
    kind: "flag",
    note: "backticked BigQuery FQN — use ${ref(...)} (declare it as a source) or a quoted Postgres name",
  },
];

/**
 * Config-block keys that don't apply on Postgres: commented out + flagged.
 * (`database:` is the BigQuery project qualifier — with defaultProject gone it resolves to an
 * empty string and fails config verification; partition/cluster keys translate to postgres:{}.)
 */
const CONFIG_BQ_KEYS = /^(\s*)(bigquery\s*:|partitionBy\s*:|clusterBy\s*:|requirePartitionFilter\s*:|partitionExpirationDays\s*:|database\s*:)/;

// ---------------------------------------------------------------------------------------------
// Per-file transforms
// ---------------------------------------------------------------------------------------------

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, "_");
/** ONE connection per source GCP project — declarations carry their own dataset via schema:. */
export const connectionNameFor = (project: string) => `bq_${sanitize(project)}`;

/**
 * Rewrite one declaration .sqlx: same file, config regenerated to ride the named connection.
 * The BigQuery data stays where it is — this is the ONLY change a source file receives.
 */
export function convertDeclaration(
  source: string,
  parsed: ParsedSqlxConfig,
  connection: string,
  sourceDataset: string,
  filePath: string,
): { content: string; findings: FileFinding[] } {
  const span = findConfigBlock(source)!;
  const description = parsed.description
    ? `    description: ${JSON.stringify(parsed.description)},\n`
    : "";
  // `schema:` stays — it names the source dataset on the connection AND the Postgres schema
  // the extract materializes into, so schema-qualified refs keep resolving.
  const newConfig = `config {
    type: "declaration",
    connection: ${JSON.stringify(connection)},
    schema: ${JSON.stringify(sourceDataset)},
    name: ${JSON.stringify(parsed.name)},
${description}    columnTypes: {
        // SQLANVIL-MIGRATE(TODO): scaffold the columns from the live source:
        //   sqlanvil introspect ${connection} ${sourceDataset}.${parsed.name} --output ${filePath}
    },
}`;
  const content = source.slice(0, span.start) + newConfig + source.slice(span.end);
  return {
    content,
    findings: [
      {
        line: 1,
        kind: "rewrite",
        note: `declaration now reads BigQuery through connection "${connection}" (runner-extract); columnTypes need introspect`,
      },
    ],
  };
}

/**
 * The dialect pass for TARGET files (and .js/includes with jsMode): safe lexical rewrites
 * applied in place; every rewrite and every recognized-but-untranslatable construct gets an
 * inline `SQLANVIL-MIGRATE:` marker above the line plus a report finding. BigQuery-only config
 * keys are commented out (with their block bodies).
 */
export function convertTarget(
  source: string,
  jsMode: boolean,
  dialect: "postgres" | "none" = "postgres",
): { content: string; findings: FileFinding[] } {
  // dialect "none" = same-warehouse conversion (bigquery target): only the compile-global
  // rename applies; SQL stays in its native dialect and BigQuery config keys stay valid.
  const dialectPass = dialect === "postgres";
  const span = jsMode ? null : findConfigBlock(source);
  const findings: FileFinding[] = [];
  const lines = source.split("\n");
  const jsLines = jsMode ? new Set<number>() : jsBlockLines(source);

  let configStartLine = -1;
  let configEndLine = -1;
  if (span) {
    configStartLine = source.slice(0, span.start).split("\n").length - 1;
    configEndLine = source.slice(0, span.end).split("\n").length - 1;
  }

  const out: string[] = [];
  let commentingConfigBlockDepth = 0; // >0 while commenting out a multi-line bigquery: { ... }
  let swallowLeadingComma = false; // after a commented block: absorb an orphaned separator comma

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const inConfig = i >= configStartLine && i <= configEndLine && configStartLine >= 0;
    // Inside sqlx js{} blocks and .js files, inserted lines can land inside template literals
    // and break the JS — so those regions get rewrites + report findings but NO inline markers.
    const markersSafe = !jsMode && !jsLines.has(i);
    const marker = (note: string) =>
      inConfig ? `// SQLANVIL-MIGRATE: ${note}` : `-- SQLANVIL-MIGRATE: ${note}`;
    const lineNo = i + 1;
    const notesForLine: string[] = [];

    // Global rename rules apply everywhere (plain token replacement — string-safe).
    for (const rule of GLOBAL_RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        line = line.replace(rule.pattern, rule.replacement!);
        findings.push({ line: lineNo, kind: "rewrite", note: rule.note });
      }
    }

    // Orphaned separator comma left when the preceding config entry was commented out.
    if (swallowLeadingComma) {
      swallowLeadingComma = false;
      if (/^\s*,\s*$/.test(line)) {
        out.push(`// ${line}`);
        continue;
      }
      if (/^\s*,/.test(line)) {
        line = line.replace(/,/, " ");
      }
    }

    // Postgres-inapplicable config keys: comment the key (and its {...} block) out.
    if (dialectPass && inConfig && commentingConfigBlockDepth === 0) {
      const m = CONFIG_BQ_KEYS.exec(line);
      if (m) {
        const note = `BigQuery-only setting — not applicable on Postgres (partitioning/clustering → postgres: {}; project qualifiers drop)`;
        findings.push({ line: lineNo, kind: "flag", note });
        out.push(marker(note));
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        commentingConfigBlockDepth = Math.max(0, opens - closes);
        if (commentingConfigBlockDepth === 0) swallowLeadingComma = !/,\s*$/.test(line) ? true : false;
        out.push(`// ${line}`);
        continue;
      }
    } else if (commentingConfigBlockDepth > 0) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      commentingConfigBlockDepth = Math.max(0, commentingConfigBlockDepth + opens - closes);
      if (commentingConfigBlockDepth === 0 && !/,\s*$/.test(line)) swallowLeadingComma = true;
      out.push(`// ${line}`);
      continue;
    }

    // SQL rules (SQL bodies + js regions; config lines only get the config handling above).
    if (dialectPass && (!inConfig || jsMode)) {
      for (const rule of SQL_RULES) {
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(line)) continue;
        if (rule.replacement !== undefined) {
          rule.pattern.lastIndex = 0;
          line = line.replace(rule.pattern, rule.replacement);
          findings.push({ line: lineNo, kind: "rewrite", note: rule.note });
          if (markersSafe) notesForLine.push(rule.note);
        } else {
          findings.push({ line: lineNo, kind: "flag", note: rule.note });
          if (markersSafe) notesForLine.push(rule.note);
        }
      }
    }

    for (const note of notesForLine) {
      out.push(marker(note));
    }
    out.push(line);
  }

  let content = out.join("\n");
  // .js files (and only they) get one safe top-of-file summary block instead of inline markers.
  if (jsMode && findings.length > 0) {
    const noted = findings.slice(0, 12).map(f => ` *   L${f.line}: ${f.note}`);
    const more = findings.length > 12 ? [` *   …and ${findings.length - 12} more (see migration-report.json)`] : [];
    content =
      ["/* SQLANVIL-MIGRATE — findings in this file (inline markers are unsafe in JS templates):", ...noted, ...more, " */"].join("\n") +
      "\n" +
      content;
  }

  return { content, findings };
}

// ---------------------------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------------------------

interface SourceProjectConfig {
  defaultProject: string | null;
  defaultLocation: string | null;
  defaultDataset: string;
  defaultAssertionDataset: string | null;
  vars: Record<string, string> | null;
  raw: Record<string, unknown>;
}

function readSourceConfig(srcDir: string): SourceProjectConfig {
  const wsPath = path.join(srcDir, "workflow_settings.yaml");
  const djPath = path.join(srcDir, "dataform.json");
  let raw: Record<string, unknown>;
  if (fs.existsSync(wsPath)) {
    raw = (loadYaml(fs.readFileSync(wsPath, "utf8")) as Record<string, unknown>) || {};
  } else if (fs.existsSync(djPath)) {
    raw = JSON.parse(fs.readFileSync(djPath, "utf8"));
  } else {
    throw new Error(
      `${srcDir} does not look like a Dataform project (no workflow_settings.yaml or dataform.json).`,
    );
  }
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : null);
  return {
    defaultProject: s("defaultProject") ?? s("defaultDatabase"),
    defaultLocation: s("defaultLocation"),
    defaultDataset: s("defaultDataset") ?? s("defaultSchema") ?? "dataform",
    defaultAssertionDataset: s("defaultAssertionDataset") ?? s("assertionSchema"),
    vars: (raw.vars as Record<string, string>) ?? null,
    raw,
  };
}

export async function migrateDataform(opts: MigrateDataformOptions): Promise<MigrationReport> {
  const srcDir = path.resolve(opts.srcDir);
  const outDir = path.resolve(opts.outDir);
  if (containsPath(srcDir, outDir)) {
    throw new Error("The output directory must not be inside the source project.");
  }
  if (containsPath(outDir, srcDir)) {
    throw new Error("The source project must not be inside the output directory.");
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new Error(`Output directory ${outDir} is not empty.`);
  }

  const targetWarehouse = opts.targetWarehouse ?? "supabase";
  const isBigQueryTarget = targetWarehouse === "bigquery";

  const sourceConfig = readSourceConfig(srcDir);
  const writer = new OutWriter(outDir);
  skippedForSafety = new Set<string>();
  const files = walkFiles(srcDir);

  const report: MigrationReport = {
    targetWarehouse,
    generator: `sqlanvil migrate-dataform ${sqlanvilVersion}`,
    sourceDir: srcDir,
    sourceConfig: sourceConfig.raw,
    inventory: { sqlxFiles: 0, jsFiles: 0, byType: {} },
    connections: [],
    overlappingSchemas: [],
    files: [],
    skippedForSafety: [],
    warnings: [],
  };

  // ---- Pass 1: inventory + classification (static scan of literal configs) ----------------
  interface SqlxInfo {
    rel: string;
    source: string;
    parsed: ParsedSqlxConfig;
  }
  const sqlxFiles: SqlxInfo[] = [];
  for (const rel of files) {
    if (!rel.endsWith(".sqlx")) continue;
    const source = fs.readFileSync(path.join(srcDir, rel), "utf8");
    const span = findConfigBlock(source);
    const parsed = span
      ? parseSqlxConfig(span.body)
      : { type: null, schema: null, database: null, name: null, description: null };
    sqlxFiles.push({ rel, source, parsed });
    report.inventory.sqlxFiles++;
    const t = parsed.type ?? "(none)";
    report.inventory.byType[t] = (report.inventory.byType[t] ?? 0) + 1;
  }

  const resolveDatabase = (db: string | null) =>
    !db || db === "<defaultDatabase>" ? sourceConfig.defaultProject ?? "UNKNOWN_PROJECT" : db;

  // Source schemas (declarations) vs target schemas (materializing actions). Connections
  // only exist when MOVING warehouse — a bigquery target reads its declarations natively.
  const declarationSchemas = new Set<string>();
  const targetSchemas = new Set<string>();
  const connectionMap = new Map<string, SourceConnection>();
  for (const f of isBigQueryTarget ? [] : sqlxFiles) {
    if (f.parsed.type === "declaration") {
      const dataset = f.parsed.schema ?? sourceConfig.defaultDataset;
      const project = resolveDatabase(f.parsed.database);
      declarationSchemas.add(dataset);
      const name = connectionNameFor(project);
      const existing = connectionMap.get(name);
      if (existing) {
        existing.declarationCount++;
        if (!existing.datasets.includes(dataset)) existing.datasets.push(dataset);
      } else {
        connectionMap.set(name, {
          name,
          project,
          datasets: [dataset],
          declarationCount: 1,
          introspectExample: `sqlanvil introspect ${name} <dataset>.<table> --output <declaration.sqlx>`,
        });
      }
    } else if (f.parsed.type) {
      targetSchemas.add(f.parsed.schema ?? sourceConfig.defaultDataset);
    }
  }
  report.connections = [...connectionMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  report.overlappingSchemas = [...declarationSchemas].filter(s => targetSchemas.has(s)).sort();

  // ---- Pass 2: write the converted tree ----------------------------------------------------
  for (const rel of files) {
    const abs = path.join(srcDir, rel);

    if (rel === "workflow_settings.yaml" || rel === "dataform.json") {
      continue; // replaced below
    }

    if (rel.endsWith(".sqlx")) {
      const info = sqlxFiles.find(f => f.rel === rel)!;
      if (isBigQueryTarget) {
        // Same-warehouse conversion: declarations AND targets pass through untouched apart
        // from the compile-global rename (dataform.projectConfig → sqlanvil.projectConfig).
        const { content, findings } = convertTarget(info.source, false, "none");
        writer.write(rel, content);
        report.files.push({
          file: rel,
          action: info.parsed.type === "declaration" ? "declaration" : "target",
          type: info.parsed.type ?? "(none)",
          status: findings.length === 0 ? "clean" : "rewritten",
          findings,
        });
        continue;
      }
      if (info.parsed.type === "declaration") {
        const dataset = info.parsed.schema ?? sourceConfig.defaultDataset;
        const project = resolveDatabase(info.parsed.database);
        const connection = connectionNameFor(project);
        const { content, findings } = convertDeclaration(
          info.source,
          info.parsed,
          connection,
          dataset,
          rel,
        );
        writer.write(rel, content);
        report.files.push({
          file: rel,
          action: "declaration",
          type: "declaration",
          status: "rewritten",
          findings,
          connection,
        });
      } else {
        const { content, findings } = convertTarget(info.source, false);
        writer.write(rel, content);
        report.files.push({
          file: rel,
          action: "target",
          type: info.parsed.type ?? "(none)",
          status:
            findings.length === 0
              ? "clean"
              : findings.some(f => f.kind === "flag")
                ? "flagged"
                : "rewritten",
          findings,
        });
      }
      continue;
    }

    if (rel.endsWith(".js") && (rel.startsWith("definitions/") || rel.startsWith("includes/"))) {
      report.inventory.jsFiles++;
      const source = fs.readFileSync(abs, "utf8");
      const { content, findings } = convertTarget(source, true, isBigQueryTarget ? "none" : "postgres");
      writer.write(rel, content);
      const isIncludes = rel.startsWith("includes/");
      if (isIncludes && findings.length > 0 && !isBigQueryTarget) {
        report.warnings.push(
          `includes helper ${rel} emits BigQuery-flavored SQL — review its ${findings.length} finding(s)`,
        );
      }
      report.files.push({
        file: rel,
        action: isIncludes ? "includes" : "target",
        type: "js",
        status:
          findings.length === 0
            ? "clean"
            : findings.some(f => f.kind === "flag")
              ? "flagged"
              : "rewritten",
        findings,
      });
      continue;
    }

    // Everything else: byte-for-byte copy.
    writer.write(rel, fs.readFileSync(abs));
    report.files.push({ file: rel, action: "copied", status: "clean", findings: [] });
  }

  // ---- workflow_settings.yaml ---------------------------------------------------------------
  // bigquery target: same warehouse, so project/location carry through and dataset ids keep
  // their case (BigQuery datasets are case-sensitive; the lowercase fold is a PG-ism). The
  // `warehouse:` key is omitted — BigQuery is core's implicit default, matching `init`.
  const settings: Record<string, unknown> = isBigQueryTarget
    ? {
        ...(sourceConfig.defaultProject ? { defaultProject: sourceConfig.defaultProject } : {}),
        ...(sourceConfig.defaultLocation ? { defaultLocation: sourceConfig.defaultLocation } : {}),
        defaultDataset: sourceConfig.defaultDataset,
        defaultAssertionDataset: sourceConfig.defaultAssertionDataset ?? "sqlanvil_assertions",
        sqlanvilCoreVersion: opts.coreVersion ?? sqlanvilVersion,
      }
    : {
        warehouse: targetWarehouse,
        defaultDataset: sourceConfig.defaultDataset.toLowerCase(),
        defaultAssertionDataset: (sourceConfig.defaultAssertionDataset ?? "sqlanvil_assertions").toLowerCase(),
        sqlanvilCoreVersion: opts.coreVersion ?? sqlanvilVersion,
      };
  if (sourceConfig.vars) settings.vars = sourceConfig.vars;
  if (report.connections.length > 0) {
    settings.connections = Object.fromEntries(
      report.connections.map(c => [
        c.name,
        {
          platform: "bigquery",
          project: c.project,
          billingProject: sourceConfig.defaultProject ?? "REPLACE_WITH_YOUR_GCP_PROJECT",
          mode: "runner-extract",
        },
      ]),
    );
  }
  writer.write("workflow_settings.yaml", dumpYaml(settings));

  // Repo-scoped agent guidance for the CONVERTED project (with the converted-project
  // addendum pointing at the migration report). If the source shipped its own AGENTS.md /
  // CLAUDE.md, the walk copied it — keep the user's file and just note it.
  if (!fs.existsSync(path.join(outDir, "AGENTS.md"))) {
    writer.write(
      "AGENTS.md",
      agentsMdContents({
        warehouse: targetWarehouse,
        defaultDataset: settings.defaultDataset as string,
        version: opts.coreVersion ?? sqlanvilVersion,
        converted: true
      })
    );
    report.files.push({ file: "AGENTS.md", action: "generated", status: "clean", findings: [] });
  } else {
    report.warnings.push(
      "Source AGENTS.md copied as-is — its guidance targets Dataform; consider replacing it with the sqlanvil version (`sqlanvil init --bare` in an empty dir generates one)."
    );
  }
  if (!fs.existsSync(path.join(outDir, "CLAUDE.md"))) {
    writer.write("CLAUDE.md", claudeMdBridgeContents());
    report.files.push({ file: "CLAUDE.md", action: "generated", status: "clean", findings: [] });
  }

  report.skippedForSafety = [...skippedForSafety].sort();
  if (skippedForSafety.size > 0) {
    report.warnings.push(
      `Skipped ${skippedForSafety.size} file(s)/dir(s) for safety (credentials, build artifacts, VCS) — see skippedForSafety`,
    );
  }

  writer.write("migration-report.json", JSON.stringify(report, null, 2));
  writer.write("migration-report.md", renderReportMd(report));
  return report;
}

// ---------------------------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------------------------

export function renderReportMd(r: MigrationReport): string {
  const targets = r.files.filter(f => f.action === "target");
  const flagged = targets.filter(f => f.status === "flagged");
  const rewritten = targets.filter(f => f.status === "rewritten");
  const clean = targets.filter(f => f.status === "clean");
  const declarations = r.files.filter(f => f.action === "declaration");

  const lines: string[] = [];
  lines.push(`# Dataform → SQLAnvil migration report`);
  lines.push("");
  lines.push(`Generated by ${r.generator} from \`${r.sourceDir}\` (source untouched).`);
  lines.push("");
  lines.push(`## Inventory`);
  lines.push("");
  lines.push(`- ${r.inventory.sqlxFiles} .sqlx, ${r.inventory.jsFiles} .js`);
  for (const [t, n] of Object.entries(r.inventory.byType).sort((a, b) => b[1] - a[1])) {
    lines.push(`  - ${t}: ${n}`);
  }
  lines.push("");
  if (r.targetWarehouse === "bigquery") {
    lines.push(`## Same-warehouse conversion (BigQuery → BigQuery)`);
    lines.push("");
    lines.push(
      `This is a tooling swap: the project keeps running on the SAME BigQuery warehouse. SQL ` +
        `bodies, \`bigquery: {}\` config blocks, and declarations passed through untouched; ` +
        `only the compile global was renamed (\`dataform.projectConfig\` → ` +
        `\`sqlanvil.projectConfig\`) and the settings file converted.`,
    );
  } else {
  lines.push(`## Source connections (${r.connections.length})`);
  lines.push("");
  lines.push(
    `Declarations keep reading BigQuery through named \`connections:\` in workflow_settings.yaml ` +
      `(mode: runner-extract — no Vault, no wrappers). Each declaration needs \`columnTypes\` ` +
      `before it can extract; scaffold them with \`sqlanvil introspect\`:`,
  );
  lines.push("");
  for (const c of r.connections) {
    lines.push(
      `- **${c.name}** — project \`${c.project}\`, ${c.declarationCount} declaration(s) across ` +
        `${c.datasets.length} dataset(s): ${c.datasets.slice(0, 8).map(d => `\`${d}\``).join(", ")}` +
        (c.datasets.length > 8 ? ", …" : ""),
    );
    lines.push(`  - \`${c.introspectExample}\``);
  }
  if (r.overlappingSchemas.length > 0) {
    lines.push("");
    lines.push(`## ⚠ Schemas that are BOTH source and target`);
    lines.push("");
    lines.push(
      `These schemas have declarations AND materializing actions: ${r.overlappingSchemas
        .map(s => `\`${s}\``)
        .join(", ")}. ` +
        `Their declared tables are probably produced by this pipeline (or a sibling) — once those ` +
        `producers move to Postgres, convert the declarations to plain local declarations instead ` +
        `of BigQuery connections.`,
    );
  }
  }
  lines.push("");
  lines.push(`## Target files (${targets.length})`);
  lines.push("");
  lines.push(`- clean: ${clean.length}`);
  lines.push(`- rewritten (safe lexical changes only): ${rewritten.length}`);
  lines.push(`- **flagged (need dialect review): ${flagged.length}** — every location is marked ` +
    `inline with \`SQLANVIL-MIGRATE:\``);
  lines.push("");
  for (const f of flagged) {
    lines.push(`- \`${f.file}\` (${f.type})`);
    for (const finding of f.findings.filter(x => x.kind === "flag").slice(0, 6)) {
      lines.push(`  - L${finding.line}: ${finding.note}`);
    }
    const more = f.findings.filter(x => x.kind === "flag").length - 6;
    if (more > 0) lines.push(`  - …and ${more} more (see migration-report.json)`);
  }
  lines.push("");
  lines.push(`## Declarations (${declarations.length})`);
  lines.push("");
  lines.push(
    r.targetWarehouse === "bigquery"
      ? `Declarations are unchanged — the sources are native to the warehouse.`
      : `Every declaration was rewritten to ride its connection. The BigQuery data does not move.`,
  );
  if (r.warnings.length > 0) {
    lines.push("");
    lines.push(`## Warnings`);
    lines.push("");
    for (const w of r.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push(`## Finish the migration`);
  lines.push("");
  if (r.targetWarehouse === "bigquery") {
    lines.push(`1. \`sqlanvil compile\` — should already succeed.`);
    lines.push(
      `2. Credentials: \`gcloud auth application-default login\` (ADC), or a service-account ` +
        `key in a gitignored \`.df-credentials.json\`.`,
    );
    lines.push(
      `3. \`sqlanvil validate\` — dry-runs every model against BigQuery without executing; ` +
        `all-PASS means the swap is complete.`,
    );
    lines.push(
      `4. Compare \`sqlanvil compile\` output with \`dataform compile\` on the source for a ` +
        `sample of actions — they should match apart from the compile-global rename.`,
    );
  } else {
    lines.push(`1. \`sqlanvil compile\` — should already succeed.`);
    lines.push(
      `2. Scaffold \`columnTypes\` for the declarations you actually read (see connections above).`,
    );
    lines.push(
      `3. \`sqlanvil validate\` against your Postgres/Supabase warehouse — PASS/FAILURE/BLOCKED per ` +
        `model is the migration to-do list. Work the flagged files until validate is green.`,
    );
    lines.push(
      `4. This report is machine-readable (migration-report.json) — pointing an AI agent at it plus ` +
        `the \`SQLANVIL-MIGRATE:\` markers is the fastest path through the dialect work.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
