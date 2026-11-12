import { init } from "sa/cli/api";
import { projectDirOption } from "sa/cli/common_options";
import { print, printInitResult } from "sa/cli/console";
import { runInteractiveInit } from "sa/cli/interactive_init";
import { ProjectConfigOptions } from "sa/cli/project_config_options";
import { promptForIcebergConfig } from "sa/cli/util";
import { ICommand, option, positionalOption } from "sa/cli/yargswrapper";
import { sqlanvil } from "sa/protos/ts";

interface InitArgv {
  "project-dir": string;
  "default-database"?: string;
  "default-location"?: string;
  warehouse: string;
  iceberg: boolean;
  bare: boolean;
  interactive: boolean;
}

const icebergOption = option("iceberg", {
  describe: "BigQuery only. Prompts for a workflow-level BigQuery Iceberg table configuration.",
  type: "boolean",
  default: false,
});

const bareOption = option("bare", {
  describe: "Skip the sample files; create empty (gitkept) directories only.",
  type: "boolean",
  default: false,
});

const interactiveOption = option("interactive", {
  describe:
    "Guided Q&A setup: start a fresh project (warehouse, sample project, credentials) or " +
    "convert an existing Dataform project. Other init arguments are ignored except " +
    "project-dir, which seeds the directory prompt.",
  type: "boolean",
  default: false,
});

const warehouseOption = option("warehouse", {
  describe: "Target warehouse for the new project: bigquery, postgres, supabase or mysql.",
  type: "string",
  choices: ["bigquery", "postgres", "supabase", "mysql"],
  default: "supabase",
});

export const initCommand: ICommand = {
  format:
    `init [${projectDirOption.name}] [${ProjectConfigOptions.defaultDatabase.name}]` +
    ` [${ProjectConfigOptions.defaultLocation.name}]`,
  description:
    "Create a new sqlanvil project (BigQuery, Postgres, Supabase, or MySQL/MariaDB). " +
    "Use --interactive for a guided setup, including converting a Dataform project.",
  positionalOptions: [
    projectDirOption,
    positionalOption(
      ProjectConfigOptions.defaultDatabase.name,
      {
        describe:
          "BigQuery: the Google Cloud project ID models build in. Required for BigQuery; ignored " +
          "for the other warehouses.",
      },
      (argv: InitArgv) => {
        const warehouse = argv[warehouseOption.name] || "bigquery";
        if (
          warehouse === "bigquery" &&
          !argv[interactiveOption.name] &&
          !argv[ProjectConfigOptions.defaultDatabase.name]
        ) {
          throw new Error(
            `The ${ProjectConfigOptions.defaultDatabase.name} positional argument is ` +
              `required for BigQuery projects. Use "sqlanvil help init" for more info.`,
          );
        }
      },
    ),
    positionalOption(ProjectConfigOptions.defaultLocation.name, {
      describe:
        "BigQuery only, optional, e.g. US or europe-west2. If omitted, defaultLocation is not " +
        "written to workflow_settings.yaml and the credentials file's location is used; if that " +
        "is also unset, BigQuery infers each job's location from the tables it reads, and new " +
        "datasets are created in US.",
    }),
  ],
  options: [warehouseOption, icebergOption, bareOption, interactiveOption],
  processFn: async (argv: InitArgv) => {
    const projectDir = argv[projectDirOption.name];
    if (argv[interactiveOption.name]) {
      return runInteractiveInit(projectDir);
    }
    const warehouse = argv[warehouseOption.name] || "bigquery";
    const projectConfig: sqlanvil.IProjectConfig = { warehouse };
    if (warehouse === "bigquery") {
      projectConfig.defaultDatabase = argv[ProjectConfigOptions.defaultDatabase.name];
      projectConfig.defaultLocation = argv[ProjectConfigOptions.defaultLocation.name];
    }

    if (argv[icebergOption.name]) {
      const icebergConfig = promptForIcebergConfig();
      if (icebergConfig) {
        projectConfig.defaultIcebergConfig = icebergConfig;
      }
    }

    print("Writing project files...\n");

    const initResult = await init(projectDir, projectConfig, {
      includeSample: !argv[bareOption.name],
    });
    printInitResult(initResult);
    return 0;
  },
};
