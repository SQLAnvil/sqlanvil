// Ported from upstream dataform-co/dataform cli/api/utils/query_transforms.ts (3.1.5, #2421).
// Taken: the GoogleSQL lexer helpers, setsDatasetId (#2421) and wrapWithCreateSchemaIfNotExists
// (#2408). concatenateQueries (#2413) was declined and stays in dbadapters/tasks.ts — see
// version.bzl.

/**
 * Whether the string or bytes literal opening quote (`'` or `"`) at `quoteIndex` is preceded by a
 * GoogleSQL raw literal prefix (`r`, `rb` or `br`, case-insensitive).
 */
function hasRawLiteralPrefix(statement: string, quoteIndex: number): boolean {
  const prefix = statement.slice(Math.max(0, quoteIndex - 3), quoteIndex);
  return /(?:^|[^a-zA-Z0-9_])(?:r|rb|br)$/i.test(prefix);
}

/**
 * Returns `statement` with comments (`--`, `#` and `/* *\/`) and the contents of string/bytes
 * literals (single, double and triple quoted, including raw literals) and quoted identifiers
 * replaced with spaces of the same length. Preserving lengths keeps character indices aligned
 * with `statement`, while leaving only unquoted SQL tokens and empty quotes.
 */
function stripCommentsAndQuotedContent(statement: string): string {
  let result = "";
  let i = 0;
  while (i < statement.length) {
    const char = statement[i];
    const next = statement[i + 1];
    if ((char === "-" && next === "-") || char === "#") {
      const newline = statement.indexOf("\n", i);
      const end = newline === -1 ? statement.length : newline;
      result += " ".repeat(end - i);
      i = end;
    } else if (char === "/" && next === "*") {
      const close = statement.indexOf("*/", i + 2);
      const end = close === -1 ? statement.length : close + 2;
      result += " ".repeat(end - i);
      i = end;
    } else if (char === "'" || char === '"' || char === "`") {
      const isRaw = char !== "`" && hasRawLiteralPrefix(statement, i);
      const tripleQuote = char.repeat(3);
      const closing = char !== "`" && statement.startsWith(tripleQuote, i) ? tripleQuote : char;
      const start = i;
      i += closing.length;
      while (i < statement.length && !statement.startsWith(closing, i)) {
        // Skip escaped characters, e.g. \' inside a non-raw single-quoted string.
        i += !isRaw && statement[i] === "\\" ? 2 : 1;
      }
      i = Math.min(i + closing.length, statement.length);
      result +=
        closing +
        " ".repeat(Math.max(0, i - start - 2 * closing.length)) +
        (i - start >= 2 * closing.length ? closing : "");
    } else {
      result += char;
      i++;
    }
  }
  return result;
}

/**
 * Whether the given GoogleSQL statement or script sets the `@@dataset_id` system variable (e.g.
 * `SET @@dataset_id = '...'`), ignoring comments, string literals, and quoted identifiers. Note:
 * SET directives inside quoted SQL expressions (e.g. EXECUTE IMMEDIATE blocks) will not be detected.
 */
export function setsDatasetId(statement: string): boolean {
  return (
    // Quick check to filter out obvious negatives before a more detailed parse
    /@@dataset_id\b/i.test(statement) &&
    /(?:^|[^a-zA-Z0-9_@$])set\s+(?:@@dataset_id\b|\([^;)=]*@@dataset_id\b)/i.test(
      stripCommentsAndQuotedContent(statement),
    )
  );
}

// sqlanvil's concatenateQueries: upstream's version from #2413/#2414 was declined, so its comment
// handling (only a `--` comment on the statement's last line counts as trailing) is kept.
function formatStatement(statement: string, isLast: boolean, modifier?: (mod: string) => string) {
  // Only treat a comment as trailing if it lives on the statement's last line.
  // Searching from the last newline avoids misreading an interior comment (e.g.
  // inside a multi-line procedure body) as a trailing comment.
  const lastLineStart = statement.lastIndexOf("\n") + 1;
  const commentIndex = statement.indexOf("--", lastLineStart);

  let code: string;
  let comment: string;

  if (commentIndex === 0) {
    code = "";
    comment = statement;
  } else if (commentIndex > 0) {
    code = statement.substring(0, commentIndex).trimEnd();
    comment = statement.substring(commentIndex);
  } else {
    code = statement;
    comment = "";
  }

  if (modifier && code.length > 0) {
    code = modifier(code);
  }

  if (!isLast && code.length > 0 && !code.endsWith(";")) {
    code = code + ";";
  }

  if (code.length > 0 && comment.length > 0) {
    return code + " " + comment;
  }
  return code || comment;
}

export function concatenateQueries(
  statements: string[],
  modifier?: (mod: string) => string,
  // False keeps each statement's leading whitespace, so that its lines stay where they were (for
  // mapping error positions, upstream #2408).
  trimLeadingWhitespace = true,
) {
  const processed = statements
    .filter((statement) => !!statement)
    .map((statement) => (trimLeadingWhitespace ? statement.trim() : statement.trimEnd()))
    .filter((statement) => statement.length > 0);
  const formattedStatements = processed.map((statement, index) =>
    formatStatement(statement, index === processed.length - 1, modifier),
  );
  return formattedStatements.join("\n");
}

/**
 * Terminates each statement with a semicolon (placed before a trailing comment) and joins the
 * non-empty ones with newlines. Unlike concatenateQueries, the last statement is terminated too,
 * for statements that are followed by more code in the same script (upstream #2320).
 */
export function terminateStatements(statements: string[]): string {
  return statements
    .filter((statement) => !!statement)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => formatStatement(statement, false))
    .join("\n");
}

/**
 * Returns the index just after the last character of code in the given GoogleSQL statement, i.e.
 * ignoring trailing whitespace and comments (`--`, `#` and `/* *\/`). String literals (single,
 * double and triple quoted) and quoted identifiers are skipped as a whole, so that e.g. a `--`
 * inside a string literal is not mistaken for a comment. Returns 0 if the statement has no code.
 */
function codeEndIndex(statement: string): number {
  let codeEnd = 0;
  let i = 0;
  while (i < statement.length) {
    const char = statement[i];
    const next = statement[i + 1];
    if ((char === "-" && next === "-") || char === "#") {
      const newline = statement.indexOf("\n", i);
      i = newline === -1 ? statement.length : newline + 1;
    } else if (char === "/" && next === "*") {
      const end = statement.indexOf("*/", i + 2);
      i = end === -1 ? statement.length : end + 2;
    } else if (char === "'" || char === '"' || char === "`") {
      const isRaw = char !== "`" && hasRawLiteralPrefix(statement, i);
      const tripleQuote = char.repeat(3);
      const closing = char !== "`" && statement.startsWith(tripleQuote, i) ? tripleQuote : char;
      i += closing.length;
      while (i < statement.length && !statement.startsWith(closing, i)) {
        // Skip escaped characters, e.g. \' inside a non-raw single-quoted string.
        i += !isRaw && statement[i] === "\\" ? 2 : 1;
      }
      i = Math.min(i + closing.length, statement.length);
      codeEnd = i;
    } else {
      i++;
      if (!/\s/.test(char)) {
        codeEnd = i;
      }
    }
  }
  return codeEnd;
}

/**
 * Terminates the code of the given GoogleSQL statement with a semicolon, placed before any
 * trailing comment (a semicolon after a trailing `--` or `#` comment would be commented out).
 */
function terminateStatement(statement: string): string {
  const codeEnd = codeEndIndex(statement);
  const code = statement.substring(0, codeEnd);
  const comment = statement.substring(codeEnd);
  return code.length > 0 && !code.endsWith(";") ? `${code};${comment}` : code + comment;
}

/**
 * Number of lines `wrapWithCreateSchemaIfNotExists()` adds before the wrapped statement: the
 * statement starts on line `1 + CREATE_SCHEMA_WRAPPER_LINE_OFFSET` of the script.
 */
export const CREATE_SCHEMA_WRAPPER_LINE_OFFSET = 2;

/**
 * Wraps the given statement (or script) so that the `database.schema` dataset is created, if it
 * doesn't exist yet, in the same BigQuery job. This lets BigQuery infer the location of the new
 * dataset from the tables read by the statement.
 *
 * The statement is wrapped in a `BEGIN ... END` block, rather than just prepended with the
 * `CREATE SCHEMA` statement, because `DECLARE` statements are only allowed at the start of a
 * script or block. BigQuery only: on Postgres and MySQL `begin` opens a transaction.
 */
export function wrapWithCreateSchemaIfNotExists(
  database: string | undefined,
  schema: string,
  statement: string,
): string {
  const schemaRef = database ? `${database}.${schema}` : schema;
  return `create schema if not exists \`${schemaRef}\`;\nbegin\n${terminateStatement(
    statement.trim(),
  )}\nend;`;
}
