// Ported from upstream dataform-co/dataform cli/api/utils/query_transforms.ts (3.1.5, #2421).
// Only the GoogleSQL lexer helper and setsDatasetId are taken; concatenateQueries (#2413) was
// declined and wrapWithCreateSchemaIfNotExists (#2408) is deferred — see version.bzl.

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
