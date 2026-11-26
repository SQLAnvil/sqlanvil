// The release suite's strict expected failure (docs/prd/sqlanvil/testing.md, Harness, Layout):
// `sa/testing` has no expected-failure mode, so a known-failing case runs its body through
// `strictKnownFailure`. The body checks for the case's `symptom:` before its other assertions and,
// when it sees it, throws `KnownFailure` for the case's E-nnn. Only that exception counts as the
// expected failure: the test passes then, and fails when the body passes ("unexpected pass") or
// fails in any other way ("not the known failure").

/** The expected-failure exception a known-failing body raises when it sees its symptom. */
export class KnownFailure extends Error {
  public readonly entry: string;

  constructor(entry: string, symptom: string) {
    super(`known failure ${entry}: ${symptom}`);
    this.name = "KnownFailure";
    this.entry = entry;
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message}`;
  }
  return String(e);
}

/**
 * Runs `body` as the strict expected failure of `entry` (an E-nnn): resolves only when `body`
 * throws `KnownFailure` for that entry; throws "unexpected pass" when `body` resolves, and
 * "not the known failure" when `body` throws anything else.
 */
export async function strictKnownFailure(entry: string, body: () => Promise<void>): Promise<void> {
  let thrown: unknown;
  let threw = false;
  try {
    await body();
  } catch (e) {
    threw = true;
    thrown = e;
  }
  if (!threw) {
    throw new Error(`unexpected pass: the case marked known-failing ${entry} passed`);
  }
  if (thrown instanceof KnownFailure && thrown.entry === entry) {
    process.stdout.write(`KNOWN-FAILING ${entry}: ${thrown.message}\n`);
    return;
  }
  throw new Error(`not the known failure ${entry}: ${describe(thrown)}`);
}
