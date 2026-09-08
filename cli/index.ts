import yargs from "yargs";

import {
  compileCommand,
  docsCommand,
  formatCommand,
  helpCommand,
  initCommand,
  initCredsCommand,
  inspectCommand,
  installCommand,
  introspectCommand,
  migrateDataformCommand,
  migrateFixCommand,
  queryCommand,
  runCommand,
  testCommand,
  validateCommand
} from "sa/cli/commands";
import { printError } from "sa/cli/console";
import { createYargsCli } from "sa/cli/yargswrapper";

process.on("unhandledRejection", async (reason: unknown) => {
  printError(`Unhandled promise rejection: ${(reason as Error)?.stack || reason}`);
});

// Each command lives in cli/commands/<name>_command.ts; options shared across commands
// are in cli/common_options.ts and the workflow_settings overrides in
// cli/project_config_options.ts. This file only registers them (order = help order).
export function runCli() {
  const builtYargs = createYargsCli({
    commands: [
      helpCommand,
      initCommand,
      installCommand,
      initCredsCommand,
      compileCommand,
      testCommand,
      validateCommand,
      runCommand,
      queryCommand,
      inspectCommand,
      docsCommand,
      formatCommand,
      introspectCommand,
      migrateDataformCommand,
      migrateFixCommand
    ]
  })
    .scriptName("sqlanvil")
    .strict()
    .wrap(null)
    .recommendCommands()
    .fail(async (msg: string, err: Error) => {
      if (!!err && err.name === "VMError" && err.message.includes("Cannot find module")) {
        printError("Could not find NPM dependencies. Have you run 'sqlanvil install'?");
      } else {
        const message = err?.message ? err.message.split("\n")[0] : msg;
        printError(`sqlanvil encountered an error: ${message}`);
        if (err?.stack) {
          printError(err.stack);
        }
      }
      process.exit(1);
    }).argv;

  // If no command is specified, show top-level help string.
  if (!builtYargs._[0]) {
    yargs.showHelp();
  }
}
