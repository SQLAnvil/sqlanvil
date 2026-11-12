import { migrateDataform } from "sa/cli/api/commands/migrate_dataform";
import { print } from "sa/cli/console";
import { printMigrationSummary } from "sa/cli/interactive_init";
import { ICommand, option, positionalOption } from "sa/cli/yargswrapper";

const targetWarehouseOption = option("target-warehouse", {
  describe:
    "Where the converted project runs. supabase or postgres moves the warehouse: BigQuery " +
    "sources become named connections and the SQL gets safe dialect rewrites plus inline " +
    "SQLANVIL-MIGRATE markers. bigquery is a tooling swap: the project keeps running on " +
    "BigQuery with its SQL and bigquery: {} blocks untouched.",
  type: "string",
  choices: ["supabase", "postgres", "bigquery"],
  default: "supabase",
});

export const migrateDataformCommand: ICommand = {
  format: "migrate-dataform <source-dir> <out-dir>",
  description:
    "Convert a Dataform project to sqlanvil. The source directory is never modified; the " +
    "converted project and its migration report are written to out-dir, which must be empty.",
  positionalOptions: [
    positionalOption("source-dir", {
      describe: "The Dataform project to convert (never modified).",
    }),
    positionalOption("out-dir", {
      describe: "Where the converted sqlanvil project is written (created; must be empty).",
    }),
  ],
  options: [targetWarehouseOption],
  processFn: async (argv: {
    "source-dir": string;
    "out-dir": string;
    "target-warehouse": "supabase" | "postgres" | "bigquery";
  }) => {
    const report = await migrateDataform({
      srcDir: argv["source-dir"],
      outDir: argv["out-dir"],
      targetWarehouse: argv[targetWarehouseOption.name],
    });
    printMigrationSummary(report, argv["out-dir"]);
    print(`Next: sqlanvil compile ${argv["out-dir"]}`);
    return 0;
  },
};
