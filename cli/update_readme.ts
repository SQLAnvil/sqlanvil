import * as fs from "fs";
import * as path from "path";

import { CLI_COMMANDS } from "sa/cli/commands";
import { printError, printSuccess, printWarning } from "sa/cli/console";
import { generateReadme, replaceMirrorBody } from "sa/cli/readme_generator";

// Regenerates the generated blocks of cli/README.md from the CLI command definitions, then copies
// its body into the sqlanvil.com mirror when the sibling sqlanvil-com checkout exists.
// Usage: bazel run //cli:update_readme
const workspaceDir = process.env.BUILD_WORKSPACE_DIRECTORY;
if (!workspaceDir) {
  printError("This script must be run with: bazel run //cli:update_readme");
  process.exit(1);
}

const readmePath = path.join(workspaceDir, "cli", "README.md");
const { content, changedBlocks } = generateReadme(
  fs.readFileSync(readmePath, "utf8"),
  CLI_COMMANDS,
);
writeIfChanged(readmePath, content, changedBlocks.join(", "));

const mirrorPath = path.join(
  workspaceDir,
  "..",
  "sqlanvil-com",
  "src",
  "content",
  "docs",
  "docs",
  "reference",
  "cli.md",
);
if (fs.existsSync(mirrorPath)) {
  const mirror = fs.readFileSync(mirrorPath, "utf8");
  writeIfChanged(mirrorPath, replaceMirrorBody(content, mirror), "body synced from cli/README.md");
} else {
  printWarning(
    `${mirrorPath} not found; the sqlanvil.com mirror of cli/README.md was not updated. ` +
      "Copy the README body into sqlanvil-com src/content/docs/docs/reference/cli.md by hand.",
  );
}

function writeIfChanged(filePath: string, newContent: string, what: string) {
  if (fs.readFileSync(filePath, "utf8") === newContent) {
    // Not written, to avoid touching the file's mtime (and triggering watchers or rebuilds).
    printSuccess(`${filePath} is already up to date.`);
    return;
  }
  fs.writeFileSync(filePath, newContent);
  printSuccess(`Updated ${filePath}: ${what}`);
}
