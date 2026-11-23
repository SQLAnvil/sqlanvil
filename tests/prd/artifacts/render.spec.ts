// The docs renderer: FR-022 of docs/prd/sqlanvil/features/artifacts.md.
import { expect } from "chai";

import { renderDocsHtml } from "sa/cli/api/commands/docs";
import { suite, test } from "sa/testing";

const render: any = renderDocsHtml;

// &M1 of T-022.1; a fresh copy per case.
function m1(): any {
  return {
    generatedAt: "2026-06-24T00:00:00Z",
    summary: {
      total: 2,
      byType: [
        { type: "table", n: 1 },
        { type: "view", n: 1 },
      ],
    },
    latestRun: { runId: 123, status: "FAILED" },
    models: [
      {
        readable: "s.src",
        type: "table",
        tags: ["daily"],
        description: 'a <b>source</b> & "x"',
        status: "SUCCESSFUL",
        dependsOn: [],
      },
      {
        readable: "s.v",
        type: "view",
        tags: [],
        description: "",
        status: "FAILED",
        dependsOn: ["s.src", "s.other"],
      },
    ],
    columns: [{ readable: "s.src", column: "id", description: "the id" }],
  };
}

function countBadges(html: string): number {
  let n = 0;
  const re = /class="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1].split(/\s+/).includes("badge")) {
      n++;
    }
  }
  return n;
}

suite("prd artifacts: docs renderer", () => {
  test("@prd T-022.1 renders one self-contained HTML document", async () => {
    const html: string = await render(m1());
    expect(html.startsWith("<!doctype html>"), html.slice(0, 40)).to.equal(true);
    for (const text of ["<title>SQLAnvil catalog</title>", "<style>", "<script>"]) {
      expect(html).to.contain(text);
    }
    for (const text of ["src=", "href="]) {
      expect(html).to.not.contain(text);
    }
  });

  test("@prd T-022.2 renders the meta line", async () => {
    const html: string = await render(m1());
    expect(html).to.contain(
      '<div class="meta">2 models — 1 table, 1 view &middot; Last run: <strong>FAILED</strong> (run 123) &middot; generated 2026-06-24T00:00:00Z</div>',
    );
  });

  test("@prd T-022.3 renders the run line with and without a latest run", async () => {
    const first: string = await render(m1());
    expect(first).to.contain("Last run: <strong>FAILED</strong> (run 123)");
    const model = m1();
    delete model.latestRun;
    const second: string = await render(model);
    expect(second).to.contain("No runs recorded yet.");
    expect(second).to.not.contain("Last run:");
  });

  test("@prd T-022.4 renders one models-table row per model", async () => {
    const model = m1();
    model.models.push({
      readable: "s.w",
      type: "view",
      tags: [],
      description: "",
      status: "SKIPPED",
      dependsOn: [],
    });
    model.models.push({ readable: "s.n", type: "table", tags: [], description: "", dependsOn: [] });
    const html: string = await render(model);
    for (const text of [
      "<td><code>s.src</code></td>",
      '<span class="tag">daily</span>',
      '<span class="badge ok">SUCCESSFUL</span>',
      '<span class="badge fail">FAILED</span>',
      '<span class="badge muted">SKIPPED</span>',
      "<code>s.src</code><br><code>s.other</code>",
    ]) {
      expect(html).to.contain(text);
    }
    expect(countBadges(html), "elements with class badge").to.equal(3);
  });

  test("@prd T-022.5 escapes model and column values", async () => {
    const model = m1();
    model.columns = [{ readable: "s.src", column: "id", description: "<i>k</i>" }];
    const html: string = await render(model);
    expect(html).to.contain("a &lt;b&gt;source&lt;/b&gt; &amp; &quot;x&quot;");
    expect(html).to.contain("&lt;i&gt;k&lt;/i&gt;");
    expect(html).to.not.contain("a <b>source</b>");
    expect(html).to.not.contain("<i>k</i>");
  });

  test("@prd T-022.6 renders a single row when there are no columns", async () => {
    const model = m1();
    model.columns = [];
    const html: string = await render(model);
    expect(html).to.contain('<tr><td colspan="3" class="meta">No documented columns.</td></tr>');
  });

  test("@prd T-022.7 renders lower-cased data-search attributes and the filter script", async () => {
    const model = m1();
    model.models[0].readable = "S.Src";
    model.models[0].tags = ["Daily", "Hot"];
    const html: string = await render(model);
    for (const text of [
      'data-search="s.src table daily hot"',
      'data-search="s.v view "',
      'oninput="filterModels(this.value)"',
      "function filterModels(q)",
    ]) {
      expect(html).to.contain(text);
    }
  });
});
