export { compileCommand } from "sa/cli/commands/compile_command";
export { docsCommand } from "sa/cli/commands/docs_command";
export { formatCommand } from "sa/cli/commands/format_command";
export { helpCommand } from "sa/cli/commands/help_command";
export { initCommand } from "sa/cli/commands/init_command";
export { initCredsCommand } from "sa/cli/commands/init_creds_command";
export { inspectCommand } from "sa/cli/commands/inspect_command";
export { installCommand } from "sa/cli/commands/install_command";
export { introspectCommand } from "sa/cli/commands/introspect_command";
export { migrateDataformCommand } from "sa/cli/commands/migrate_dataform_command";
export { migrateFixCommand } from "sa/cli/commands/migrate_fix_command";
export { queryCommand } from "sa/cli/commands/query_command";
export { runCommand } from "sa/cli/commands/run_command";
export { testCommand } from "sa/cli/commands/test_command";
export { validateCommand } from "sa/cli/commands/validate_command";

import { compileCommand } from "sa/cli/commands/compile_command";
import { docsCommand } from "sa/cli/commands/docs_command";
import { formatCommand } from "sa/cli/commands/format_command";
import { initCommand } from "sa/cli/commands/init_command";
import { initCredsCommand } from "sa/cli/commands/init_creds_command";
import { inspectCommand } from "sa/cli/commands/inspect_command";
import { installCommand } from "sa/cli/commands/install_command";
import { introspectCommand } from "sa/cli/commands/introspect_command";
import { migrateDataformCommand } from "sa/cli/commands/migrate_dataform_command";
import { migrateFixCommand } from "sa/cli/commands/migrate_fix_command";
import { queryCommand } from "sa/cli/commands/query_command";
import { runCommand } from "sa/cli/commands/run_command";
import { testCommand } from "sa/cli/commands/test_command";
import { validateCommand } from "sa/cli/commands/validate_command";
import { ICommand } from "sa/cli/yargswrapper";

// The CLI's commands, in the order they are listed in `sqlanvil help` and cli/README.md (each
// needs a section there; see cli/readme_generator.ts). runCli() puts `help` in front of them.
export const CLI_COMMANDS: ICommand[] = [
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
  migrateFixCommand,
];
