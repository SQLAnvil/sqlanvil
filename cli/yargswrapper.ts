import yargs from "yargs";

import { dataformVersion, version } from "sa/core/version";

export interface ICli {
  commands: ICommand[];
}

export interface ICommand {
  format: string;
  description: string;
  positionalOptions: Array<INamedOption<yargs.PositionalOptions>>;
  options: Array<INamedOption<yargs.Options>>;
  // Each command annotates its own handler with a command-specific argv interface
  // (see cli/index.ts). The wrapper plumbing stays argv-agnostic; the compile-time
  // safety lives in those annotated handler bodies.
  processFn: (argv: any) => Promise<number>;
}

export interface INamedOption<T, TName extends string = string> {
  // TName is captured as a string literal by the `option`/`positionalOption`
  // factories in cli/index.ts, so `argv[someOption.name]` indexes a typed argv
  // interface by the exact flag name instead of a widened `string`.
  name: TName;
  option: T;
  check?: (args: any) => void;
}

// Factories that capture the option name as a string literal type. Prefer these
// over object literals typed `INamedOption<...>` (which widen `name` to `string`).
export function option<TName extends string>(
  name: TName,
  opt: yargs.Options,
  check?: (args: any) => void
): INamedOption<yargs.Options, TName> {
  return { name, option: opt, check };
}

export function positionalOption<TName extends string>(
  name: TName,
  opt: yargs.PositionalOptions,
  check?: (args: any) => void
): INamedOption<yargs.PositionalOptions, TName> {
  return { name, option: opt, check };
}

export function createYargsCli(cli: ICli) {
  let yargsChain = yargs(fixArgvForHelp());
  for (const command of cli.commands) {
    yargsChain = yargsChain.command(
      command.format,
      command.description,
      (yargsChainer: yargs.Argv) => createOptionsChain(yargsChainer, command),
      async (argv: { [argumentName: string]: any }) => {
        const exitCode = await command.processFn(argv);
        process.exit(exitCode);
      }
    );
  }
  return yargsChain.version(`sqlanvil ${version} (Dataform core ${dataformVersion})`);
}

function createOptionsChain(yargsChain: yargs.Argv, command: ICommand) {
  const checks: Array<(args: yargs.Arguments) => void> = [];

  for (const positionalOption of command.positionalOptions) {
    yargsChain = yargsChain.positional(positionalOption.name, positionalOption.option);
    if (positionalOption.check) {
      checks.push(positionalOption.check);
    }
  }
  for (const option of command.options) {
    yargsChain = yargsChain.option(option.name, option.option);
    if (option.check) {
      checks.push(option.check);
    }
  }
  yargsChain = yargsChain.check(argv => {
    checks.forEach(check => check(argv));
    return true;
  });
  return yargsChain;
}

function fixArgvForHelp() {
  // Obviously this is a massive hack.
  // The outcome of this is that the following commands are interchangeable:
  // $ sqlanvil help run
  // $ sqlanvil --help run
  // The problem is that yargs.help() only allows us to specify an alias for the "--help" built-in option (by default that alias is "help").
  // But because "--help" is only an option, not a command, it appears to be impossible (?) to configure yargs to respond to "help" correctly
  // (or at least, to correctly print help strings for commands; it happily prints a top-level help string).
  const argvCopy = process.argv.slice(2);
  if (argvCopy[0] === "help") {
    argvCopy[0] = "--help";
  }
  return argvCopy;
}
