import { ProjectConfigOptions } from "sa/cli/project_config_options";
import { ICommand, INamedOption } from "sa/cli/yargswrapper";

// Generates the parts of cli/README.md that are derived from the CLI command definitions.
// Ported from upstream dataform-co/dataform (3.1.5, #2419). sqlanvil differences: usage lines are
// `sqlanvil ...` in a bash fence, the command list is a Command | Purpose table (plus `help`), the
// project-config table has an Overrides column (from `docs.overrides`), and the same blocks are
// generated into the sqlanvil.com mirror of this file (see cli/update_readme.ts), so errors name
// the file they're about.
//
// Generated content lives between marker comments, which don't render on GitHub or npm:
//
//   <!-- BEGIN GENERATED: options run -->
//   ...
//   <!-- END GENERATED: options run -->
//
// Everything outside the markers is hand-written and left untouched. Supported blocks:
//   commands                 the table of commands, linking to their sections
//   usage <command>          the command's usage line
//   positionals <command>    the command's positional arguments table
//   options <command>        the command's options table
//   project-config-options   the options shared by commands that override workflow_settings.yaml

// Command used to regenerate cli/README.md, shown in error messages.
export const UPDATE_README_COMMAND = "bazel run //cli:update_readme";

const BEGIN_MARKER = /^<!-- BEGIN GENERATED: (.+?) -->$/;
const END_MARKER = /^<!-- END GENERATED: (.+?) -->$/;

const PROJECT_CONFIG_OPTIONS_BLOCK = "project-config-options";
const COMMANDS_BLOCK = "commands";
const PER_COMMAND_BLOCK_KINDS = ["usage", "positionals", "options"];

type AnyOption = INamedOption<any, any>;

export interface IGeneratedReadme {
  // The README with all generated blocks regenerated.
  content: string;
  // Names of the blocks whose content changed, e.g. "options run".
  changedBlocks: string[];
  // Details of the blocks whose content changed, for error messages.
  staleBlocks: IStaleBlock[];
}

export interface IStaleBlock {
  name: string;
  // 1-based line number in the README of the first line inside the block.
  firstLine: number;
  // The block's lines as they are in the README.
  current: string[];
  // The block's lines as generated from the CLI definitions.
  expected: string[];
}

export interface IGenerateReadmeOptions {
  // How errors refer to the file being generated. Defaults to cli/README.md.
  fileLabel?: string;
}

const DEFAULT_FILE_LABEL = "cli/README.md";

export function generateReadme(
  readme: string,
  commands: ICommand[],
  { fileLabel = DEFAULT_FILE_LABEL }: IGenerateReadmeOptions = {},
): IGeneratedReadme {
  const lines = readme.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  const staleBlocks: IStaleBlock[] = [];
  const seenBlocks = new Set<string>();

  let openBlock: { name: string; line: number; content: string[] } | null = null;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const begin = line.match(BEGIN_MARKER);
    const end = line.match(END_MARKER);
    if (begin) {
      if (openBlock) {
        throw new Error(
          `${fileLabel}:${lineNumber}: found "BEGIN GENERATED: ${begin[1]}" before ` +
            `"END GENERATED: ${openBlock.name}" (opened on line ${openBlock.line}).`,
        );
      }
      const name = begin[1];
      if (seenBlocks.has(name)) {
        throw new Error(`${fileLabel}:${lineNumber}: duplicate generated block "${name}".`);
      }
      seenBlocks.add(name);
      openBlock = { name, line: lineNumber, content: [] };
      output.push(line);
    } else if (end) {
      if (!openBlock || end[1] !== openBlock.name) {
        throw new Error(
          `${fileLabel}:${lineNumber}: "END GENERATED: ${end[1]}" doesn't match ` +
            (openBlock ? `"BEGIN GENERATED: ${openBlock.name}".` : "any BEGIN GENERATED marker."),
        );
      }
      const generated = renderBlock(openBlock.name, commands, fileLabel);
      if (openBlock.content.join("\n") !== generated.join("\n")) {
        staleBlocks.push({
          name: openBlock.name,
          firstLine: openBlock.line + 1,
          current: openBlock.content,
          expected: generated,
        });
      }
      output.push(...generated, line);
      openBlock = null;
    } else if (openBlock) {
      openBlock.content.push(line);
    } else {
      output.push(line);
    }
  });
  if (openBlock) {
    throw new Error(
      `${fileLabel}:${openBlock.line}: "BEGIN GENERATED: ${openBlock.name}" is never closed.`,
    );
  }

  checkAllBlocksPresent(seenBlocks, commands, fileLabel);
  return {
    content: output.join("\n"),
    changedBlocks: staleBlocks.map((block) => block.name),
    staleBlocks,
  };
}

// Explains which generated blocks of cli/README.md are out of date, showing only the lines that
// differ, and how to fix it.
export function formatStaleBlocks(
  staleBlocks: IStaleBlock[],
  fileLabel: string = DEFAULT_FILE_LABEL,
): string {
  const blocks = staleBlocks.map((block) => {
    const lastLine = block.firstLine + Math.max(block.current.length - 1, 0);
    const labelled = diffLines(block.current, block.expected).map(({ kind, line, index }) => ({
      label:
        kind === "current" ? `README (line ${block.firstLine + index}):` : "expected from cli/:",
      line,
    }));
    // Align the lines so that the differences are easy to spot.
    const labelWidth = Math.max(...labelled.map(({ label }) => label.length));
    const diff = labelled.map(({ label, line }) => `  ${label.padEnd(labelWidth)} ${line}`);
    return [
      `Block "${block.name}" (${fileLabel}, lines ${block.firstLine}-${lastLine}):`,
      ...diff,
    ].join("\n");
  });
  return [
    `${fileLabel} is out of date with the CLI command and option definitions in cli/.`,
    "",
    ...blocks.flatMap((block) => [block, ""]),
    "To fix it:",
    `- If you changed a command or option in cli/, run: ${UPDATE_README_COMMAND}`,
    `- If you edited a generated block in ${fileLabel} by hand, revert that edit and change the`,
    "  definition in cli/ instead (cli/commands/*.ts, cli/common_options.ts or",
    `  cli/project_config_options.ts), then run: ${UPDATE_README_COMMAND}`,
  ].join("\n");
}

interface IDiffLine {
  kind: "current" | "expected";
  line: string;
  // Index of the line in `current` or `expected`, depending on `kind`.
  index: number;
}

// Returns the lines that differ between `current` and `expected` (based on their longest common
// subsequence), in order. Generated blocks are small, so the quadratic algorithm is fine.
function diffLines(current: string[], expected: string[]): IDiffLine[] {
  const common: number[][] = Array.from({ length: current.length + 1 }, () =>
    new Array(expected.length + 1).fill(0),
  );
  for (let i = current.length - 1; i >= 0; i--) {
    for (let j = expected.length - 1; j >= 0; j--) {
      common[i][j] =
        current[i] === expected[j]
          ? common[i + 1][j + 1] + 1
          : Math.max(common[i + 1][j], common[i][j + 1]);
    }
  }
  const diff: IDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < current.length || j < expected.length) {
    if (i < current.length && j < expected.length && current[i] === expected[j]) {
      i++;
      j++;
    } else if (
      j >= expected.length ||
      (i < current.length && common[i + 1][j] >= common[i][j + 1])
    ) {
      diff.push({ kind: "current", line: current[i], index: i });
      i++;
    } else {
      diff.push({ kind: "expected", line: expected[j], index: j });
      j++;
    }
  }
  return diff;
}

function checkAllBlocksPresent(seenBlocks: Set<string>, commands: ICommand[], fileLabel: string) {
  for (const required of [COMMANDS_BLOCK, PROJECT_CONFIG_OPTIONS_BLOCK]) {
    if (!seenBlocks.has(required)) {
      throw new Error(`${fileLabel} has no "${required}" generated block.`);
    }
  }
  for (const command of commands) {
    const name = commandName(command);
    const missing = PER_COMMAND_BLOCK_KINDS.filter((kind) => !seenBlocks.has(`${kind} ${name}`));
    if (missing.length > 0) {
      throw new Error(
        `${fileLabel} is missing the generated block(s) ${missing
          .map((kind) => `"${kind} ${name}"`)
          .join(", ")} for the "${name}" command. A new command needs a section like:\n\n` +
          commandSectionSkeleton(name),
      );
    }
  }
}

function commandSectionSkeleton(name: string): string {
  const block = (kind: string) =>
    `<!-- BEGIN GENERATED: ${kind} ${name} -->\n<!-- END GENERATED: ${kind} ${name} -->`;
  return [
    `### \`${name}\``,
    "",
    block("usage"),
    "",
    `TODO: describe what \`${name}\` does.`,
    "",
    "**Positional arguments**",
    "",
    block("positionals"),
    "",
    "**Options**",
    "",
    block("options"),
    "",
    `Then run: ${UPDATE_README_COMMAND}`,
  ].join("\n");
}

function renderBlock(blockName: string, commands: ICommand[], fileLabel: string): string[] {
  if (blockName === COMMANDS_BLOCK) {
    return [
      "| Command | Purpose |",
      "|---|---|",
      ...commands.map((command) => {
        const name = commandName(command);
        return tableRow([`[\`${name}\`](#${name})`, textCell(command.description)]);
      }),
      // `help` has no section: runCli() adds it, and yargs implements it.
      tableRow(["`help [command]`", "Show help for every command, or for one command."]),
    ];
  }
  if (blockName === PROJECT_CONFIG_OPTIONS_BLOCK) {
    return renderProjectConfigTable(ProjectConfigOptions.allYargsOptions);
  }
  const [kind, name, ...rest] = blockName.split(" ");
  const command = commands.find((c) => commandName(c) === name);
  if (!PER_COMMAND_BLOCK_KINDS.includes(kind) || !name || rest.length > 0) {
    throw new Error(`${fileLabel}: unknown generated block "${blockName}".`);
  }
  if (!command) {
    throw new Error(
      `${fileLabel}: generated block "${blockName}" refers to the unknown command "${name}".`,
    );
  }
  switch (kind) {
    case "usage":
      return ["```bash", `sqlanvil ${command.format}`, "```"];
    case "positionals":
      return renderPositionalsTable(command);
    default:
      return renderCommandOptionsTable(command.options);
  }
}

function renderPositionalsTable(command: ICommand): string[] {
  const positionals: AnyOption[] = command.positionalOptions;
  if (positionals.length === 0) {
    return ["None."];
  }
  return [
    "| Argument | Required | Description |",
    "|---|---|---|",
    ...positionals.map((positional) =>
      tableRow([
        codeCell(positional.name),
        requiredCell(positional, command),
        textCell(describe(positional)),
      ]),
    ),
  ];
}

function renderCommandOptionsTable(options: AnyOption[]): string[] {
  // Commands that accept all project-config overrides list them in a single row pointing to the
  // shared table, rather than repeating them in every command. This relies on reference identity:
  // the command must reuse the ProjectConfigOptions.allYargsOptions objects, so a command that
  // wraps or copies one of them falls back to listing all its options in the full table.
  const projectConfigOptions: AnyOption[] = ProjectConfigOptions.allYargsOptions;
  const hasAllProjectConfigOptions = projectConfigOptions.every((option) =>
    options.includes(option),
  );
  if (!hasAllProjectConfigOptions) {
    return renderOptionsTable(options);
  }
  const commandOptions = options.filter((option) => !projectConfigOptions.includes(option));
  return renderOptionsTable(commandOptions, [
    tableRow([
      "Project-config overrides",
      "—",
      "—",
      "See [Project-config flags](#project-config-flags).",
    ]),
  ]);
}

function renderOptionsTable(options: AnyOption[], extraRows: string[] = []): string[] {
  if (options.length === 0 && extraRows.length === 0) {
    return ["None."];
  }
  return [
    "| Flag | Type | Default | Description |",
    "|---|---|---|---|",
    ...options.map((option) =>
      tableRow([
        codeCell(`--${option.name}`),
        option.option.type ? textCell(option.option.type) : "—",
        defaultCell(option),
        textCell(describe(option)),
      ]),
    ),
    ...extraRows,
  ];
}

// The project-config flags all default to the workflow_settings.yaml value, so instead of a Default
// column the shared table names the setting each flag overrides.
function renderProjectConfigTable(options: AnyOption[]): string[] {
  return [
    "| Flag | Type | Overrides | Description |",
    "|---|---|---|---|",
    ...options.map((option) =>
      tableRow([
        codeCell(`--${option.name}`),
        option.option.type ? textCell(option.option.type) : "—",
        option.docs?.overrides ? codeCell(option.docs.overrides) : "—",
        textCell(describe(option)),
      ]),
    ),
  ];
}

function requiredCell(positional: AnyOption, command: ICommand): string {
  // yargs requires a positional written as `<name>` in the command's format.
  const inAngleBrackets = command.format.split(" ").includes(`<${positional.name}>`);
  if (positional.docs?.required || positional.option.demandOption || inAngleBrackets) {
    return "**Yes**";
  }
  const defaultValue = defaultCell(positional);
  return defaultValue === "—" ? "No" : `No (default ${defaultValue})`;
}

// Table cells are built from three kinds of content, each rendered differently:
// - plain text (e.g. an option's `describe`, shared with `sqlanvil help`): escaped, see textCell(),
// - values rendered as inline code (option names, declared defaults): see codeCell(),
// - markdown written for the README (`docs.default`, fixed strings in this file): used as is.

function defaultCell(option: AnyOption): string {
  if (option.docs?.default !== undefined) {
    return markdownCell(option.docs.default, `docs.default of --${option.name}`);
  }
  const value = option.option.default;
  if (value === undefined || value === null) {
    return "—";
  }
  return codeCell(typeof value === "string" ? value : JSON.stringify(value));
}

function describe(option: AnyOption): string {
  return String(option.option.describe || "");
}

// URLs in plain text, which GitHub turns into links.
const URL_PATTERN = /(https?:\/\/[^\s|<>]+)/;

// Escapes plain text for a markdown table cell, so that it renders exactly as written:
// - characters that markdown or GFM tables would interpret are backslash-escaped (see
//   escapeMarkdown()), except in URLs, where a backslash would break GitHub's autolinking,
// - HTML is escaped (e.g. the "<job-prefix>" in "sqlanvil-<job-prefix>-" would otherwise be
//   hidden as an unknown tag).
function textCell(text: string): string {
  return (
    text
      .replace(/\s*\n\s*/g, " ")
      .split(URL_PATTERN)
      // split() with a capturing group puts the URLs at odd indexes.
      .map((part, index) => (index % 2 === 1 ? part : escapeMarkdown(part)))
      .join("")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  );
}

// Backslash-escapes characters that markdown or GFM tables would interpret: `|` ends the cell,
// `*`, `_` and `~` format text, `[` and `]` start links, `` ` `` starts code. Backslashes are
// escaped first, so that the escapes added for the other characters can't be altered. `_` inside a
// word (e.g. workflow_settings.yaml) can't start or end emphasis, so it's only escaped at word
// boundaries, which keeps the README source readable.
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/[|*[\]~`]/g, (char) => `\\${char}`)
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "\\_");
}

// Renders a value as inline code. Backslashes are literal inside code spans, so values that would
// need escaping (backticks, `|`, line breaks) aren't supported rather than escaped.
function codeCell(value: string): string {
  if (/[`|\n]/.test(value)) {
    throw new Error(
      `README: can't render ${JSON.stringify(value)} as inline code in a table cell. ` +
        "Set the option's docs.default to the markdown to show instead.",
    );
  }
  return `\`${value}\``;
}

// Markdown written for the README is used as is, but can't contain line breaks or unescaped `|`,
// which would break the table.
function markdownCell(markdown: string, source: string): string {
  if (/\n|(^|[^\\])\|/.test(markdown)) {
    throw new Error(
      `README: ${source} can't contain line breaks or unescaped "|": ${JSON.stringify(markdown)}`,
    );
  }
  return markdown;
}

function tableRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function commandName(command: ICommand): string {
  return command.format.split(" ")[0];
}

// cli/README.md is mirrored on sqlanvil.com (sqlanvil-com src/content/docs/docs/reference/cli.md).
// Each file starts with its own header (a title or frontmatter, then an HTML comment pointing at the
// other file), and everything after that first comment is identical. Returns `mirror` with its body
// replaced by `source`'s.
export function replaceMirrorBody(source: string, mirror: string): string {
  const [, sourceBody] = splitAtHeaderComment(source, "the source");
  const [mirrorHeader] = splitAtHeaderComment(mirror, "the mirror");
  return [...mirrorHeader, ...sourceBody].join("\n");
}

function splitAtHeaderComment(text: string, label: string): [string[], string[]] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith("<!--"));
  if (start === -1 || BEGIN_MARKER.test(lines[start]) || END_MARKER.test(lines[start])) {
    throw new Error(`${label} has no header comment before its body.`);
  }
  const end = lines.findIndex((line, index) => index >= start && line.includes("-->"));
  if (end === -1) {
    throw new Error(`${label} has no header comment before its body (it is never closed).`);
  }
  return [lines.slice(0, end + 1), lines.slice(end + 1)];
}
