import { migrateFix } from "sa/cli/api/commands/migrate_fix";
import { projectDirMustExistOption } from "sa/cli/common_options";
import { print, printError } from "sa/cli/console";
import { ICommand, option } from "sa/cli/yargswrapper";

export const migrateFixCommand: ICommand = {
  format: "migrate-fix [project-dir]",
  description:
    "Finish a converted project's dialect work, AFTER `scripts/introspect_all.sh` has run. " +
    "Expands `SELECT * EXCEPT (...)` into explicit column lists and rewrites `GROUP BY ALL` " +
    "as positional ordinals — both need the source columns that only exist once " +
    "declarations have been introspected, so this is the " +
    "third phase of a migration (convert, introspect, fix), not part of the conversion. " +
    "Re-runnable; reports anything it could not resolve instead of guessing.",
  positionalOptions: [projectDirMustExistOption],
  options: [
    option("dry-run", {
      describe: "Report what would change without writing.",
      type: "boolean",
      default: false
    })
  ],
  processFn: async (argv: { "project-dir": string; "dry-run": boolean }) => {
    const result = await migrateFix({
      projectDir: argv["project-dir"],
      write: !argv["dry-run"]
    });
    const verb = argv["dry-run"] ? "would rewrite" : "rewrote";
    print(
      `${verb} ${result.expanded} star-except site(s) and ${result.groupByAll} ` +
        `GROUP BY ALL clause(s) across ${result.files.length} file(s).`
    );
    if (result.unresolved.length) {
      printError(`${result.unresolved.length} site(s) need a look:`);
      for (const u of result.unresolved) {
        printError(`  ${u.file}:${u.line} — ${u.reason}`);
      }
    }
    return result.unresolved.length ? 1 : 0;
  }
};
