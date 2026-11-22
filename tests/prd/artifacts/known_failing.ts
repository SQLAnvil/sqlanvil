// Strict expected failure for a known-failing case (docs/prd/sqlanvil/testing.md, Harness, Layout).
// `sa/testing` has no expected-failure mode, so a known-failing case runs its body through
// `expectKnownFailure`. The body checks for the case's `symptom:` and, when it sees it, calls
// `knownFailure(...)`, which throws a KnownFailure. expectKnownFailure passes only on that
// exception; it fails when the body passes (an unexpected pass: the entry may be fixed) or when
// the body fails in any other way (not the known failure).

export class KnownFailure extends Error {
  constructor(public readonly symptom: string, public readonly seen: string) {
    super(`known failure seen: ${symptom} (${seen})`);
    this.name = "KnownFailure";
  }
}

// Called by a body when it sees its case's symptom.
export function knownFailure(symptom: string, seen: string): never {
  throw new KnownFailure(symptom, seen);
}

export async function expectKnownFailure(entry: string, body: () => Promise<void>): Promise<void> {
  let error: unknown;
  let failed = false;
  try {
    await body();
  } catch (e) {
    failed = true;
    error = e;
  }
  if (!failed) {
    throw new Error(`unexpected pass: ${entry} did not show its symptom and the case passed`);
  }
  if (error instanceof KnownFailure) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`not the known failure (${entry}): ${message}`);
}

// The DuckDB parser error of E-006: `Parser Error: syntax error at or near "<token>"`, where the
// token is the start of the text after the single quote in `dirName`.
export function isParserErrorAfterQuote(error: unknown, dirName: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const quote = dirName.indexOf("'");
  if (quote < 0) {
    return false;
  }
  const after = dirName.slice(quote + 1);
  const match = /Parser Error: syntax error at or near "([^"]+)"/.exec(message);
  return !!match && after.startsWith(match[1]);
}
