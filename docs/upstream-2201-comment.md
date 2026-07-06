Ran into this in a downstream fork and landed on solution #2 (escape, don't switch to triple-quoting). Sharing the fix in case it's useful.

**Root cause**

`rowConditionsAssertion` embeds the condition twice: once raw inside `WHERE NOT (...)` (fine — multiline is valid there), and once as a string literal label via `sqlString(...)`. `sqlString` only escapes backslashes and single quotes, so a raw newline survives into the single-quoted `failing_row_condition` literal — which BigQuery rejects, since single-quoted literals can't span lines.

So the fix belongs in `sqlString`, not in the assertion template: any caller that quotes a multiline string hits the same bug.

**Fix** (`core/compilation_sql/index.ts`)

```ts
  public sqlString(stringContents: string) {
    // Escape escape characters, then single quotes, then newlines/carriage-returns.
    // BigQuery single-quoted literals can't span multiple lines, so a raw newline
    // becomes the two-char \n escape (which parses back to a newline, keeping the
    // literal single-line). Backslash escaping runs first so the escapes introduced
    // here aren't themselves doubled.
    return `'${stringContents
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")}'`;
  }
```

Ordering matters: backslash-doubling must run first, otherwise the `\n`/`\r` we introduce get re-escaped into `\\n`/`\\r` and print a literal backslash-n instead of a newline.

This keeps the `WHERE NOT (...)` clause untouched (the raw multiline expression stays as-authored) and only normalizes the label literal:

```sql
SELECT
  'a > 0\n  AND b > 0' AS failing_row_condition,
  *
FROM `project.dataset.test`
WHERE NOT (a > 0
  AND b > 0)
```

**Why escape over triple-quoting:** escaping reuses the quote-escaping path already in `sqlString`, so a single code path handles quotes, backslashes, and newlines uniformly. Triple-quoting would need its own escaping rules for embedded `'''` and still wouldn't help non-BigQuery dialects that lack triple-quoted literals.

**Tests** worth adding alongside it:

```ts
test("escapes newlines so quoted literals stay single-line", () => {
  const compiler = new CompilationSql(dataform.ProjectConfig.create(), "3.0.0");
  expect(compiler.sqlString("line1\nline2")).to.equal("'line1\\nline2'");
  expect(compiler.sqlString("line1\r\nline2")).to.equal("'line1\\r\\nline2'");
});

test("multiline rowCondition produces a single-line failing_row_condition literal", () => {
  const compiler = new CompilationSql(dataform.ProjectConfig.create(), "3.0.0");
  const result = compiler.rowConditionsAssertion("`db.schema.test`", ["a > 0\n  AND b > 0"]);
  expect(result).to.contain("'a > 0\\n  AND b > 0' AS failing_row_condition");
  expect(result).to.contain("WHERE NOT (a > 0\n  AND b > 0)");
});
```

Happy to open a PR if a maintainer's interested.
