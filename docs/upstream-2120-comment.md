Implemented this in a downstream fork and it was a small change — sharing the approach in case it's useful upstream.

**The hard part is semantics, not plumbing**

The blocker isn't the `else if (dataset instanceof IncrementalTable)` guard — removing that is trivial. The real question is *what does it mean to unit-test an incremental table?* An incremental model compiles to two different queries depending on `when(incremental())`: the full-refresh (create) form and the incremental (append/merge) form.

The pragmatic interpretation: **a unit test exercises the full-refresh (create) form.** `RefReplacingContext` already reports `incremental() === false`, so `when(incremental())` clauses resolve to their false branch with no extra work — the test verifies the base SELECT logic with `ref()`/`resolve()` swapped for the provided inputs, exactly like a `table` test. The incremental-only merge/WHERE logic isn't covered, but that path is inherently stateful (it depends on what's already in the table), so it's a poor fit for a stateless input→output unit test anyway. This is almost certainly why it was punted originally — but the create-form test is well-defined and useful on its own, and it's what most people asking for this actually want.

**Fix** (`core/actions/test.ts`) — `IncrementalTable` is already in the allowed-types guard, so this is just deleting the rejection branch and letting it fall through:

```ts
const dataset = allResolved.length > 0 ? allResolved[0] : undefined;
if (!(dataset && (dataset instanceof Table || dataset instanceof View || dataset instanceof IncrementalTable))) {
  this.session.compileError(
    new Error(`Dataset ${stringifyResolvable(this.testTarget)} could not be found.`),
    this.proto.fileName
  );
  return this.proto;
} else {
  // For incremental tables this exercises the non-incremental (create) form of the
  // query: RefReplacingContext.incremental() returns false, so `when(incremental())`
  // clauses resolve to their false branch — a unit test verifies the full-refresh
  // SELECT logic, with ref()/resolve() replaced by the provided inputs.
  const refReplacingContext = new RefReplacingContext(testContext);
  this.proto.testQuery = refReplacingContext.apply(dataset.contextableQuery);
}
```

That deletes the `else if (dataset instanceof IncrementalTable) { ... "not yet supported" ... }` branch entirely (which also resolves the wrong-error-message bug in #2117 / #2118 — the rejection is gone rather than reworded).

**Test** worth adding — proves the incremental-only clause is excluded from the compiled test query:

```ts
test(`test on an incremental dataset uses the non-incremental (create) query`, () => {
  // ... write workflow_settings + definitions dir ...

  // The incremental-only WHERE clause must be excluded from the test query: a
  // unit test exercises the full-refresh (create) form, so `when(incremental())`
  // resolves to its false branch.
  fs.writeFileSync(actionSqlxPath, `
config {
  type: "incremental",
}
SELECT 1 AS a\${when(incremental(), \` WHERE 1 = 0\`)}
  `);
  fs.writeFileSync(actionTestSqlxPath, `
config {
  type: "test",
  dataset: "action"
}
SELECT 1 AS a`);

  const result = runMainInVm(coreExecutionRequestFromPath(projectDir));

  expect(result.compile.compiledGraph.graphErrors.compilationErrors).deep.equals([]);
  const tests = result.compile.compiledGraph.tests;
  expect(tests[0].testQuery).to.contain("SELECT 1 AS a");
  expect(tests[0].testQuery).to.not.contain("WHERE 1 = 0"); // incremental branch excluded
});
```

Worth documenting the scope explicitly so it's not mistaken for testing the merge path: **tests run against the create/full-refresh query, not the incremental append.** Happy to open a PR if a maintainer wants it.
