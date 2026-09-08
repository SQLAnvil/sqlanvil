import { migrateDataform } from "sa/cli/api/commands/migrate_dataform";
import { print } from "sa/cli/console";
import { printMigrationSummary } from "sa/cli/interactive_init";
import { ICommand, option, positionalOption } from "sa/cli/yargswrapper";

const targetWarehouseOption = option("target-warehouse", {
  describe:
    "Where the CONVERTED project runs: supabase/postgres = move off BigQuery (sources become " +
    "named connections, SQL gets the dialect pass); bigquery = keep the SAME warehouse — a " +
    "tooling swap with SQL and bigquery:{} blocks untouched.",
  type: "string",
  choices: ["supabase", "postgres", "bigquery"],
  default: "supabase"
});

export const migrateDataformCommand: ICommand = {
  format: "migrate-dataform <source-dir> <out-dir>",
  description:
    "Convert a Dataform/BigQuery project to sqlanvil. The source directory is READ-ONLY; " +
    "the converted project + migration-report.{md,json} land in <out-dir> (must be empty). " +
    "Default target (supabase/postgres) MOVES the warehouse: sources stay in BigQuery as " +
    "named connections and target SQL gets safe rewrites + inline SQLANVIL-MIGRATE markers. " +
    "--target-warehouse bigquery is a TOOLING SWAP: the project keeps running on the same " +
    "BigQuery warehouse, SQL and bigquery:{} blocks untouched.",
  positionalOptions: [
    positionalOption("source-dir", {
      describe: "The Dataform project to convert (never modified)."
    }),
    positionalOption("out-dir", {
      describe: "Where the converted sqlanvil project is written (created; must be empty)."
    })
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
      targetWarehouse: argv[targetWarehouseOption.name]
    });
    printMigrationSummary(report, argv["out-dir"]);
    print(`Next: sqlanvil compile ${argv["out-dir"]}`);
    return 0;
  }
};
