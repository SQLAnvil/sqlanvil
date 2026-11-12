import { expect } from "chai";

import { ProjectConfigOptions } from "sa/cli/project_config_options";
import { formatStaleBlocks, generateReadme, replaceMirrorBody } from "sa/cli/readme_generator";
import { ICommand } from "sa/cli/yargswrapper";
import { suite, test } from "sa/testing";

// Ported from upstream dataform-co/dataform cli/readme_generator_test.ts (3.1.5, #2419), adapted
// to sqlanvil's README: `sqlanvil` usage lines in a bash fence, a Command | Purpose table, and an
// Overrides column on the project-config table.

const projectDirPositional = {
  name: "project-dir",
  option: { describe: "The sqlanvil project directory.", default: "." },
};

function command(overrides: Partial<ICommand> = {}): ICommand {
  return {
    format: "build [project-dir]",
    description: "Build the project.",
    positionalOptions: [projectDirPositional],
    options: [
      {
        name: "fast",
        option: { describe: "Builds faster.", type: "boolean", default: false },
      },
    ],
    processFn: async () => 0,
    ...overrides,
  };
}

function block(name: string, ...content: string[]): string {
  return [`<!-- BEGIN GENERATED: ${name} -->`, ...content, `<!-- END GENERATED: ${name} -->`].join(
    "\n",
  );
}

// A minimal README with every required block for the given command names, all empty.
function readmeFor(names: string[], extra = ""): string {
  return [
    "# CLI",
    block("commands"),
    ...names.map((name) =>
      [
        `### \`${name}\``,
        block(`usage ${name}`),
        block(`positionals ${name}`),
        block(`options ${name}`),
      ].join("\n"),
    ),
    "## Project-config flags",
    block("project-config-options"),
    extra,
  ].join("\n");
}

function generatedBlock(content: string, name: string): string {
  const begin = `<!-- BEGIN GENERATED: ${name} -->\n`;
  const start = content.indexOf(begin) + begin.length;
  return content.slice(start, content.indexOf(`<!-- END GENERATED: ${name} -->`, start)).trimEnd();
}

suite("readme generator", () => {
  test("generates the command table from the command descriptions", () => {
    const { content } = generateReadme(readmeFor(["build", "init-creds"]), [
      command(),
      command({ format: "init-creds [project-dir]", description: "Create a credentials file." }),
    ]);
    expect(generatedBlock(content, "commands")).equals(
      [
        "| Command | Purpose |",
        "|---|---|",
        "| [`build`](#build) | Build the project. |",
        "| [`init-creds`](#init-creds) | Create a credentials file. |",
        "| `help [command]` | Show help for every command, or for one command. |",
      ].join("\n"),
    );
  });

  test("generates the usage line", () => {
    const { content } = generateReadme(readmeFor(["build"]), [command()]);
    expect(generatedBlock(content, "usage build")).equals(
      "```bash\nsqlanvil build [project-dir]\n```",
    );
  });

  test("generates the positionals table", () => {
    const required = {
      name: "target",
      option: { describe: "The target." },
      docs: { required: true },
    };
    const optional = { name: "extra", option: { describe: "Extra." } };
    const { content } = generateReadme(readmeFor(["build"]), [
      command({ positionalOptions: [projectDirPositional, required, optional] }),
    ]);
    expect(generatedBlock(content, "positionals build")).equals(
      [
        "| Argument | Required | Description |",
        "|---|---|---|",
        "| `project-dir` | No (default `.`) | The sqlanvil project directory. |",
        "| `target` | **Yes** | The target. |",
        "| `extra` | No | Extra. |",
      ].join("\n"),
    );
  });

  test("marks positionals in angle brackets in the usage line as required", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({
        format: "build <target> [project-dir]",
        positionalOptions: [{ name: "target", option: { describe: "The target." } }],
      }),
    ]);
    expect(generatedBlock(content, "positionals build")).includes(
      "| `target` | **Yes** | The target. |",
    );
  });

  test("generates the options table", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({
        options: [
          { name: "fast", option: { describe: "Builds faster.", type: "boolean", default: false } },
          { name: "retries", option: { describe: "Retries.", type: "number", default: 3 } },
          { name: "out", option: { describe: "Output file.", type: "string", default: null } },
          { name: "credentials", option: { describe: "Credentials.", default: "creds.json" } },
          {
            name: "timeout",
            option: { describe: "Timeout.", type: "string", default: null },
            docs: { default: "`'60s'`" },
          },
        ],
      }),
    ]);
    expect(generatedBlock(content, "options build")).equals(
      [
        "| Flag | Type | Default | Description |",
        "|---|---|---|---|",
        "| `--fast` | boolean | `false` | Builds faster. |",
        "| `--retries` | number | `3` | Retries. |",
        "| `--out` | string | — | Output file. |",
        "| `--credentials` | — | `creds.json` | Credentials. |",
        "| `--timeout` | string | `'60s'` | Timeout. |",
      ].join("\n"),
    );
  });

  test("collapses project-config options into a single row", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({
        options: [
          { name: "fast", option: { describe: "Builds faster.", type: "boolean" } },
          ...ProjectConfigOptions.allYargsOptions,
        ],
      }),
    ]);
    expect(generatedBlock(content, "options build")).equals(
      [
        "| Flag | Type | Default | Description |",
        "|---|---|---|---|",
        "| `--fast` | boolean | — | Builds faster. |",
        "| Project-config overrides | — | — | See [Project-config flags](#project-config-flags). |",
      ].join("\n"),
    );
  });

  test("lists every project-config option with the setting it overrides", () => {
    const { content } = generateReadme(readmeFor(["build"]), [command()]);
    const sharedTable = generatedBlock(content, "project-config-options");
    expect(sharedTable.split("\n").slice(0, 2)).deep.equals([
      "| Flag | Type | Overrides | Description |",
      "|---|---|---|---|",
    ]);
    for (const option of ProjectConfigOptions.allYargsOptions) {
      expect(sharedTable).includes(`| \`--${option.name}\` |`);
    }
    expect(sharedTable).includes("| `--default-database` | string | `defaultProject` |");
    expect(sharedTable).includes("| `--environment` | string | — |");
  });

  test("renders commands without options or positionals", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({ positionalOptions: [], options: [] }),
    ]);
    expect(generatedBlock(content, "positionals build")).equals("None.");
    expect(generatedBlock(content, "options build")).equals("None.");
  });

  test("escapes descriptions as plain text", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({
        options: [
          { name: "mode", option: { describe: "Either a|b,\nor c.", type: "string" } },
          {
            name: "path",
            option: { describe: "A path like C:\\dir\\|x, *not* `code`.", type: "string" },
          },
        ],
      }),
    ]);
    const table = generatedBlock(content, "options build");
    expect(table).includes("| `--mode` | string | — | Either a\\|b, or c. |");
    // The backslash before "|" is escaped too, so the "|" can't end the cell.
    expect(table).includes(
      "| `--path` | string | — | A path like C:\\\\dir\\\\\\|x, \\*not\\* \\`code\\`. |",
    );
  });

  test("escapes markdown links, emphasis and strikethrough, but not URLs", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({
        options: [
          {
            name: "docs",
            option: {
              describe:
                "Reads workflow_settings.yaml, not _this_, [this](link) or ~~that~~. " +
                "See https://example.com/a_b/c_d.md for more.",
              type: "string",
            },
          },
        ],
      }),
    ]);
    expect(generatedBlock(content, "options build")).includes(
      // `_` inside a word can't start emphasis, so it's only escaped at word boundaries.
      "| `--docs` | string | — | Reads workflow_settings.yaml, not \\_this\\_, \\[this\\](link) or " +
        "\\~\\~that\\~\\~. See https://example.com/a_b/c_d.md for more. |",
    );
  });

  test("renders declared defaults as inline code, rejecting values that can't be", () => {
    const withDefault = (value: string) =>
      command({ options: [{ name: "sep", option: { describe: "Sep.", default: value } }] });
    const { content } = generateReadme(readmeFor(["build"]), [withDefault("C:\\dir")]);
    // Backslashes are literal inside code spans, so they're not escaped.
    expect(generatedBlock(content, "options build")).includes("| `--sep` | — | `C:\\dir` | Sep. |");
    expect(() => generateReadme(readmeFor(["build"]), [withDefault("a|b")])).to.throw(
      /can't render "a\|b" as inline code/,
    );
    expect(() => generateReadme(readmeFor(["build"]), [withDefault("a`b")])).to.throw(
      /can't render "a`b" as inline code/,
    );
  });

  test("rejects docs.default markdown that would break the table", () => {
    const withDocsDefault = (markdown: string) =>
      command({
        options: [{ name: "sep", option: { describe: "Sep." }, docs: { default: markdown } }],
      });
    const { content } = generateReadme(readmeFor(["build"]), [withDocsDefault("`a\\|b`")]);
    expect(generatedBlock(content, "options build")).includes("| `--sep` | — | `a\\|b` | Sep. |");
    expect(() => generateReadme(readmeFor(["build"]), [withDocsDefault("a|b")])).to.throw(
      /docs.default of --sep can't contain line breaks or unescaped "\|"/,
    );
    expect(() => generateReadme(readmeFor(["build"]), [withDocsDefault("a\nb")])).to.throw(
      /docs.default of --sep can't contain line breaks/,
    );
  });

  test("escapes HTML in descriptions", () => {
    const { content } = generateReadme(readmeFor(["build"]), [
      command({
        options: [
          {
            name: "prefix",
            option: { describe: "Uses the form sqlanvil-<prefix>- & more.", type: "string" },
            docs: { default: "`<none>`" },
          },
        ],
      }),
    ]);
    expect(generatedBlock(content, "options build")).includes(
      "| `--prefix` | string | `<none>` | Uses the form sqlanvil-&lt;prefix&gt;- &amp; more. |",
    );
  });

  test("leaves hand-written content untouched and replaces stale blocks", () => {
    const readme = readmeFor(["build"], "Hand-written\r\nnotes.").replace(
      block("options build"),
      block("options build", "| stale |"),
    );
    const { content, changedBlocks } = generateReadme(readme, [command()]);
    expect(content).includes("# CLI\n");
    expect(content).includes("Hand-written\nnotes.");
    expect(content).not.includes("| stale |");
    expect(changedBlocks).deep.equals([
      "commands",
      "usage build",
      "positionals build",
      "options build",
      "project-config-options",
    ]);
  });

  test("explains stale blocks with the differing lines and how to fix them", () => {
    const upToDate = generateReadme(readmeFor(["build"]), [command()]).content;
    const handEdited = upToDate.replace("| Builds faster. |", "| Builds fastr. |");
    const { staleBlocks } = generateReadme(handEdited, [
      command({
        options: [
          { name: "fast", option: { describe: "Builds faster.", type: "boolean", default: false } },
          { name: "new", option: { describe: "New option.", type: "boolean" } },
        ],
      }),
    ]);
    const optionsLine = upToDate.split("\n").indexOf("<!-- BEGIN GENERATED: options build -->") + 2;
    const readmeLabel = `README (line ${optionsLine + 2}):`;
    const expectedLabel = "expected from cli/:";
    const width = Math.max(readmeLabel.length, expectedLabel.length);
    expect(formatStaleBlocks(staleBlocks)).equals(
      [
        "cli/README.md is out of date with the CLI command and option definitions in cli/.",
        "",
        `Block "options build" (cli/README.md, lines ${optionsLine}-${optionsLine + 2}):`,
        `  ${readmeLabel.padEnd(width)} | \`--fast\` | boolean | \`false\` | Builds fastr. |`,
        `  ${expectedLabel.padEnd(width)} | \`--fast\` | boolean | \`false\` | Builds faster. |`,
        `  ${expectedLabel.padEnd(width)} | \`--new\` | boolean | — | New option. |`,
        "",
        "To fix it:",
        "- If you changed a command or option in cli/, run: bazel run //cli:update_readme",
        "- If you edited a generated block in cli/README.md by hand, revert that edit and change the",
        "  definition in cli/ instead (cli/commands/*.ts, cli/common_options.ts or",
        "  cli/project_config_options.ts), then run: bazel run //cli:update_readme",
      ].join("\n"),
    );
  });

  test("names the file in errors and stale-block messages", () => {
    expect(() =>
      generateReadme(readmeFor(["build"], "<!-- BEGIN GENERATED: dangling -->"), [command()], {
        fileLabel: "reference/cli.md",
      }),
    ).to.throw(/^reference\/cli\.md:\d+: "BEGIN GENERATED: dangling" is never closed/);
    const { staleBlocks } = generateReadme(readmeFor(["build"]), [command()], {
      fileLabel: "reference/cli.md",
    });
    expect(formatStaleBlocks(staleBlocks, "reference/cli.md")).includes(
      'Block "commands" (reference/cli.md, lines',
    );
  });

  test("is idempotent", () => {
    const first = generateReadme(readmeFor(["build"]), [command()]);
    const second = generateReadme(first.content, [command()]);
    expect(second.content).equals(first.content);
    expect(second.changedBlocks).deep.equals([]);
  });

  test("fails for a command without a README section", () => {
    expect(() =>
      generateReadme(readmeFor(["build"]), [command(), command({ format: "deploy" })]),
    ).to.throw(/missing the generated block\(s\).*"deploy" command[\s\S]*### `deploy`/);
  });

  test("fails for a block referring to an unknown command", () => {
    expect(() => generateReadme(readmeFor(["build", "removed"]), [command()])).to.throw(
      /refers to the unknown command "removed"/,
    );
  });

  test("fails for an unknown block kind", () => {
    expect(() =>
      generateReadme(readmeFor(["build"], block("examples build")), [command()]),
    ).to.throw(/unknown generated block "examples build"/);
  });

  test("fails for malformed markers", () => {
    expect(() =>
      generateReadme(readmeFor(["build"], "<!-- BEGIN GENERATED: commands -->"), [command()]),
    ).to.throw(/duplicate generated block "commands"/);
    expect(() =>
      generateReadme(readmeFor(["build"], "<!-- BEGIN GENERATED: dangling -->"), [command()]),
    ).to.throw(/"BEGIN GENERATED: dangling" is never closed/);
    expect(() =>
      generateReadme(readmeFor(["build"], "<!-- END GENERATED: commands -->"), [command()]),
    ).to.throw(/doesn't match any BEGIN GENERATED marker/);
    expect(() =>
      generateReadme(
        readmeFor(["build"], "<!-- BEGIN GENERATED: a -->\n<!-- BEGIN GENERATED: b -->"),
        [command()],
      ),
    ).to.throw(/found "BEGIN GENERATED: b" before "END GENERATED: a"/);
  });

  test("fails when a required shared block is missing", () => {
    expect(() =>
      generateReadme(readmeFor(["build"]).replace(block("commands"), ""), [command()]),
    ).to.throw(/no "commands" generated block/);
  });
});

suite("replaceMirrorBody", () => {
  const readme = [
    "# SQLAnvil CLI Reference",
    "",
    "<!-- Mirror of the sqlanvil.com page.",
    "     Body below is identical. -->",
    "",
    "Body line 1.",
    "<!-- BEGIN GENERATED: commands -->",
    "| x |",
    "<!-- END GENERATED: commands -->",
    "",
  ].join("\n");

  test("replaces everything after the mirror's header comment, keeping its header", () => {
    const mirror = [
      "---",
      'title: "CLI Reference"',
      "---",
      "",
      "<!-- Mirrored in cli/README.md. -->",
      "",
      "Stale body.",
      "",
    ].join("\n");
    expect(replaceMirrorBody(readme, mirror)).equals(
      [
        "---",
        'title: "CLI Reference"',
        "---",
        "",
        "<!-- Mirrored in cli/README.md. -->",
        "",
        "Body line 1.",
        "<!-- BEGIN GENERATED: commands -->",
        "| x |",
        "<!-- END GENERATED: commands -->",
        "",
      ].join("\n"),
    );
  });

  test("leaves an up-to-date mirror unchanged", () => {
    const mirror = ["---", "title: x", "---", "", "<!-- Mirrored. -->", "", "Body line 1."].join(
      "\n",
    );
    const synced = replaceMirrorBody(readme, mirror);
    expect(replaceMirrorBody(readme, synced)).equals(synced);
  });

  test("fails when either file has no header comment", () => {
    expect(() => replaceMirrorBody("# Title\n\nBody.", "<!-- x -->\nBody.")).to.throw(
      /no header comment/,
    );
    expect(() => replaceMirrorBody(readme, "---\ntitle: x\n---\nBody.")).to.throw(
      /no header comment/,
    );
  });
});
