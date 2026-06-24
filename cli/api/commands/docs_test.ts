import { expect } from "chai";

import { DocsModel, renderDocsHtml } from "sa/cli/api/commands/docs";
import { suite, test } from "sa/testing";

suite("docs renderDocsHtml", () => {
  const model: DocsModel = {
    generatedAt: "2026-06-24T00:00:00Z",
    summary: { total: 2, byType: [{ type: "table", n: 1 }, { type: "view", n: 1 }] },
    latestRun: { runId: 123, status: "FAILED" },
    models: [
      {
        readable: "s.src",
        type: "table",
        tags: ["daily"],
        description: "a <b>source</b>",
        status: "SUCCESSFUL",
        dependsOn: []
      },
      { readable: "s.v", type: "view", tags: [], description: "", status: "FAILED", dependsOn: ["s.src"] }
    ],
    columns: [{ readable: "s.src", column: "id", description: "the id" }]
  };

  test("renders summary, models, columns; escapes HTML", () => {
    const html = renderDocsHtml(model);
    expect(html).to.contain("2 models");
    expect(html).to.contain("1 table");
    expect(html).to.contain("s.src");
    expect(html).to.contain("s.v");
    expect(html).to.contain("Depends on");
    expect(html).to.contain("the id");
    expect(html).to.contain("FAILED");
    // Description HTML is escaped, not injected raw.
    expect(html).to.contain("a &lt;b&gt;source&lt;/b&gt;");
    expect(html).to.not.contain("a <b>source</b>");
  });

  test("handles a project with no runs", () => {
    const html = renderDocsHtml({ ...model, latestRun: undefined });
    expect(html).to.contain("No runs recorded yet.");
  });
});
