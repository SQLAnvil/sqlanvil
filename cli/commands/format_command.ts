import * as fs from "fs";
import * as glob from "glob";
import * as path from "path";

import { actionsOption, projectDirMustExistOption } from "sa/cli/common_options";
import { printError, printFormatFilesResult, printSuccess } from "sa/cli/console";
import { ICommand, option } from "sa/cli/yargswrapper";
import { formatFile } from "sa/sqlx/format";

const normalizeLineEndings = (text: string) => text.replace(/\r\n/g, "\n");

interface FormatArgv {
  "project-dir": string;
  actions?: string[];
  check: boolean;
  "ignore-js-files": boolean;
}

const checkOptionName = "check";
const ignoreJsFilesOptionName = "ignore-js-files";

export const formatCommand: ICommand = {
  format: `format [${projectDirMustExistOption.name}]`,
  description: "Format the project's .sqlx and .js files in place.",
  positionalOptions: [projectDirMustExistOption],
  options: [
    // Same flag as the selection --actions (so argv parsing is shared), but for format the values
    // are file globs, so it gets its own help text.
    {
      ...actionsOption,
      option: {
        ...actionsOption.option,
        describe: "File globs to format, relative to the project directory (not action names).",
      },
      docs: { default: "`{definitions,includes}/**/*.{js,sqlx}`" },
    },
    option(checkOptionName, {
      describe: "Change nothing; exit 1 if any file would be reformatted.",
      type: "boolean",
      default: false,
    }),
    option(ignoreJsFilesOptionName, {
      describe: "Skip .js files (with the default globs, only .sqlx files are formatted).",
      type: "boolean",
      default: false,
    }),
  ],
  processFn: async (argv: FormatArgv) => {
    const extensions = argv[ignoreJsFilesOptionName] ? "*.sqlx" : "*.{js,sqlx}";
    let actions = [`{definitions,includes}/**/${extensions}`];
    if (actionsOption.name in argv && argv[actionsOption.name].length > 0) {
      actions = argv[actionsOption.name];
    }
    const filenames = actions
      .map((action: string) =>
        glob.sync(action, {
          cwd: argv[projectDirMustExistOption.name],
          // Treat "\" as a path separator only on Windows; on POSIX it remains a glob escape.
          windowsPathsNoEscape: process.platform === "win32",
        }),
      )
      .flat();

    const isCheckMode = argv[checkOptionName];
    const results: Array<{
      filename: string;
      err?: Error;
      needsFormatting?: boolean;
    }> = await Promise.all(
      filenames.map(async (filename: string) => {
        try {
          const filePath = path.resolve(argv[projectDirMustExistOption.name], filename);
          if (isCheckMode) {
            // In check mode, we don't modify files, just check if they need formatting
            const fileContent = fs.readFileSync(filePath).toString();
            const formattedContent = await formatFile(filePath, {
              overwriteFile: false,
            });
            return {
              filename,
              needsFormatting:
                normalizeLineEndings(fileContent) !== normalizeLineEndings(formattedContent),
            };
          } else {
            // Normal formatting mode
            await formatFile(filePath, {
              overwriteFile: true,
            });
            return {
              filename,
            };
          }
        } catch (e) {
          return {
            filename,
            err: e,
          };
        }
      }),
    );

    printFormatFilesResult(results);

    // Return error code if there are any formatting errors
    const failedFormatResults = results.filter((result) => !!result.err);
    if (failedFormatResults.length > 0) {
      printError(`${failedFormatResults.length} file(s) failed to format.`);
      return 1;
    }

    // In check mode, return an error code if any files need formatting
    if (isCheckMode) {
      const filesNeedingFormatting = results.filter((result) => result.needsFormatting);
      if (filesNeedingFormatting.length > 0) {
        printError(
          `${filesNeedingFormatting.length} file(s) would be reformatted. Run the format command without --check to update.`,
        );
        return 1;
      }
      printSuccess("All files are formatted correctly!");
    }

    return 0;
  },
};
