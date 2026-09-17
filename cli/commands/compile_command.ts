import * as chokidar from "chokidar";

import { compile, prune } from "sa/cli/api";
import { safeWriteArtifacts } from "sa/cli/api/commands/artifacts";
import {
  actionsOption,
  artifactsOption,
  includeDependentsOption,
  includeDepsOption,
  jsonOutputOption,
  projectConfigOverrideWithEnvironment,
  projectDirMustExistOption,
  quietCompileOption,
  tagsOption,
  timeoutOption
} from "sa/cli/common_options";
import {
  compiledGraphOutputType,
  print,
  printCompiledGraph,
  printCompiledGraphErrors,
  printError
} from "sa/cli/console";
import { ProjectConfigArgv, ProjectConfigOptions } from "sa/cli/project_config_options";
import { compiledGraphHasErrors } from "sa/cli/util";
import { ICommand, option } from "sa/cli/yargswrapper";

const RECOMPILE_DELAY = 500;

interface CompileArgv extends ProjectConfigArgv {
  "project-dir": string;
  watch: boolean;
  json: boolean;
  dot: boolean;
  timeout: number | null;
  quiet: boolean;
  verbose: boolean;
  artifacts: boolean;
  actions?: string[];
  tags?: string[];
  "include-deps"?: boolean;
  "include-dependents"?: boolean;
}

// `compile` reuses the same selection flags as `run`, but it filters the printed
// graph rather than executing actions -- so it gets output-focused help text.
// Same flag names (so argv indexing and the shared validation still apply); only
// the describe strings differ.
const compileActionsOption = {
  ...actionsOption,
  option: {
    ...actionsOption.option,
    describe:
      "A list of action names or patterns to include in the output. Can include '*' wildcards."
  }
};

const compileTagsOption = {
  ...tagsOption,
  option: { ...tagsOption.option, describe: "A list of tags to filter the output to." }
};

const compileIncludeDepsOption = {
  ...includeDepsOption,
  option: {
    ...includeDepsOption.option,
    describe: "If set, dependencies of selected actions are also included in the output."
  }
};

const compileIncludeDependentsOption = {
  ...includeDependentsOption,
  option: {
    ...includeDependentsOption.option,
    describe: "If set, dependents (downstream) of selected actions are also included in the output."
  }
};

const dotOutputOption = option(
  "dot",
  {
    describe: "Outputs a dot representation of the compiled project.",
    type: "boolean",
    default: false
  },
  (argv: { json?: boolean; dot?: boolean }) => {
    if (argv.json && argv.dot) {
      throw new Error("Arguments --json and --dot are mutually exclusive.");
    }
  }
);

const watchOptionName = "watch";
const verboseOptionName = "verbose";

export const compileCommand: ICommand = {
  format: `compile [${projectDirMustExistOption.name}]`,
  description:
    "Compile the sqlanvil project. Produces JSON output describing the non-executable graph.",
  positionalOptions: [projectDirMustExistOption],
  options: [
    option(watchOptionName, {
      describe: "Whether to watch the changes in the project directory.",
      type: "boolean",
      default: false
    }),
    jsonOutputOption,
    dotOutputOption,
    timeoutOption,
    quietCompileOption,
    compileActionsOption,
    compileTagsOption,
    compileIncludeDepsOption,
    compileIncludeDependentsOption,
    artifactsOption,
    option(
      verboseOptionName,
      {
        describe: "Enable verbose compilation output. Example usage: 'sqlanvil compile --verbose'",
        type: "boolean",
        default: false
      },
      (argv: { quiet?: boolean; verbose?: boolean }) => {
        if (argv.quiet && argv.verbose) {
          throw new Error("Arguments --verbose and --quiet are mutually exclusive.");
        }
      }
    ),
    ...ProjectConfigOptions.allYargsOptions
  ],
  processFn: async (argv: CompileArgv) => {
    const projectDir = argv[projectDirMustExistOption.name];

    async function compileAndPrint() {
      let outputType = compiledGraphOutputType.Summary;
      if (argv[jsonOutputOption.name]) {
        outputType = compiledGraphOutputType.Json;
      } else if (argv[dotOutputOption.name]) {
        outputType = compiledGraphOutputType.Dot;
      }

      if (outputType === compiledGraphOutputType.Summary) {
        print("Compiling...\n");
      }
      const compiledGraph = await compile({
        projectDir,
        projectConfigOverride: projectConfigOverrideWithEnvironment(projectDir, argv),
        timeoutMillis: argv[timeoutOption.name] || undefined,
        verbose: argv[verboseOptionName] || false
      });

      // The whole project must compile (ref() resolution needs every action
      // registered), but the printed output can be filtered to the selected
      // action(s) — mirroring how `run`/`build` prune the graph. We only prune
      // a clean graph; if compilation produced errors we print the full graph
      // plus the errors, keeping graph-level errors as-is.
      const hasSelector = argv[actionsOption.name]?.length > 0 || argv[tagsOption.name]?.length > 0;
      const outputGraph =
        hasSelector && !compiledGraphHasErrors(compiledGraph)
          ? prune(compiledGraph, {
              actions: argv[actionsOption.name],
              tags: argv[tagsOption.name],
              includeDependencies: argv[includeDepsOption.name],
              includeDependents: argv[includeDependentsOption.name]
            })
          : compiledGraph;
      printCompiledGraph(outputGraph, outputType, argv[quietCompileOption.name]);
      if (compiledGraphHasErrors(compiledGraph)) {
        print("");
        printCompiledGraphErrors(compiledGraph.graphErrors, argv[quietCompileOption.name]);
        return true;
      }
      // Write the queryable catalog (best-effort) for `sqlanvil query` / `inspect`.
      if (argv[artifactsOption.name] !== false) {
        await safeWriteArtifacts(compiledGraph, projectDir, { warn: print });
      }
      return false;
    }

    const graphHasErrors = await compileAndPrint();

    if (!argv[watchOptionName]) {
      return graphHasErrors ? 1 : 0;
    }

    let watching = true;

    let timeoutID: NodeJS.Timer = null;
    let isCompiling = false;

    // Initialize watcher.
    const watcher = chokidar.watch(projectDir, {
      ignored: /node_modules/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 200
      }
    });

    const printReady = () => {
      print("\nWatching for changes...\n");
    };
    // Add event listeners.
    watcher
      .on("ready", printReady)
      .on("error", error => {
        // This error is caught not if there is a compilation error, but
        // if the watcher fails; this indicates an failure on our side.
        printError(`Error: ${error}`);
        process.exit(1);
      })
      .on("all", () => {
        if (timeoutID || isCompiling) {
          // don't recompile many times if we changed a lot of files
          clearTimeout(timeoutID);
        }

        timeoutID = setTimeout(async () => {
          clearTimeout(timeoutID);

          if (!isCompiling) {
            isCompiling = true;
            await compileAndPrint();
            printReady();
            isCompiling = false;
          }
        }, RECOMPILE_DELAY);
      });
    process.on("SIGINT", async () => {
      await watcher.close();
      watching = false;
      process.exit(1);
    });
    while (watching) {
      await new Promise((resolve, reject) => setTimeout(() => resolve(), 100));
    }
  }
};
