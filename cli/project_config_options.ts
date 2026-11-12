import yargs from "yargs";

import { INamedOption, option } from "sa/cli/yargswrapper";
import { sqlanvil } from "sa/protos/ts";

/** The shared `ProjectConfigOptions.allYargsOptions`, all optional overrides. */
export interface ProjectConfigArgv {
  "default-database"?: string;
  "default-schema"?: string;
  "default-location"?: string;
  "assertion-schema"?: string;
  vars?: { [key: string]: string };
  "database-suffix"?: string;
  "schema-suffix"?: string;
  "table-prefix"?: string;
  "disable-assertions"?: boolean;
  "default-reservation"?: string;
  environment?: string;
}

export class ProjectConfigOptions {
  public static defaultDatabase: INamedOption<yargs.Options, "default-database"> = option(
    "default-database",
    {
      describe: "Default database. On BigQuery, the Google Cloud project ID.",
      type: "string",
    },
    undefined,
    { overrides: "defaultProject" },
  );

  public static defaultSchema: INamedOption<yargs.Options, "default-schema"> = option(
    "default-schema",
    {
      describe: "Default schema (a dataset on BigQuery).",
      type: "string",
    },
    undefined,
    { overrides: "defaultDataset" },
  );

  public static defaultLocation: INamedOption<yargs.Options, "default-location"> = option(
    "default-location",
    {
      describe:
        "BigQuery only. Default location, e.g. US. run and validate send BigQuery jobs and create " +
        "new datasets in this location, even when the credentials file names a different " +
        "location (run warns about the mismatch). See " +
        "https://cloud.google.com/bigquery/docs/locations for supported values.",
      type: "string",
    },
    undefined,
    { overrides: "defaultLocation" },
  );

  public static assertionSchema: INamedOption<yargs.Options, "assertion-schema"> = option(
    "assertion-schema",
    {
      describe: "Schema that assertions are written to.",
      type: "string",
    },
    undefined,
    { overrides: "defaultAssertionDataset" },
  );

  public static databaseSuffix: INamedOption<yargs.Options, "database-suffix"> = option(
    "database-suffix",
    {
      describe: "Suffix appended to database names.",
      type: "string",
    },
    undefined,
    { overrides: "projectSuffix" },
  );

  public static vars: INamedOption<yargs.Options, "vars"> = option(
    "vars",
    {
      describe:
        "Variables as comma-separated key=value pairs, e.g. --vars=env=staging,region=eu, read " +
        "in code as sqlanvil.projectConfig.vars.<key>. Values can't contain , or =. Keys merge " +
        "with the file's vars, so a --vars key overrides only that key.",
      type: "string",
      default: null,
      coerce: (rawVarsString: string | null) => {
        const variables: { [key: string]: string } = {};
        rawVarsString?.split(",").forEach((keyValueStr) => {
          const [key, value] = keyValueStr.split("=");
          variables[key] = value;
        });
        return variables;
      },
    },
    undefined,
    { overrides: "vars" },
  );

  public static schemaSuffix: INamedOption<yargs.Options, "schema-suffix"> = option(
    "schema-suffix",
    {
      describe:
        "Suffix appended to schema names, e.g. dev gives analytics_dev. Letters, digits and " +
        "underscores only.",
      type: "string",
    },
    (argv: Pick<ProjectConfigArgv, "schema-suffix">) => {
      if (
        argv[ProjectConfigOptions.schemaSuffix.name] &&
        !/^[a-zA-Z_0-9]+$/.test(argv[ProjectConfigOptions.schemaSuffix.name])
      ) {
        throw new Error(
          `--${ProjectConfigOptions.schemaSuffix.name} should contain only ` +
            `alphanumeric characters and/or underscores.`,
        );
      }
    },
    { overrides: "datasetSuffix" },
  );

  public static tablePrefix: INamedOption<yargs.Options, "table-prefix"> = option(
    "table-prefix",
    {
      describe: "Prefix added to every table name.",
      type: "string",
    },
    undefined,
    { overrides: "namePrefix" },
  );

  public static disableAssertions: INamedOption<yargs.Options, "disable-assertions"> = option(
    "disable-assertions",
    {
      describe:
        "Skip every assertion, built-in (uniqueKey, nonNull, rowConditions) and " +
        'type: "assertion".',
      type: "boolean",
      default: false,
    },
    undefined,
    { overrides: "disableAssertions" },
  );

  public static defaultReservation: INamedOption<yargs.Options, "default-reservation"> = option(
    "default-reservation",
    {
      describe:
        "BigQuery only. Reservation to run queries in. If neither this nor the file sets one, " +
        "default BigQuery behavior applies.",
      type: "string",
    },
    undefined,
    { overrides: "defaultReservation" },
  );

  public static environment: INamedOption<yargs.Options, "environment"> = option("environment", {
    describe:
      "Load a named environment from environments: in workflow_settings.yaml. That " +
      "environment's schemaSuffix, vars, defaultDatabase, defaultLocation and credentials file " +
      "apply, and explicit flags override them. See https://sqlanvil.com/docs/guides/environments/",
    type: "string",
  });

  public static allYargsOptions: Array<INamedOption<yargs.Options>> = [
    ProjectConfigOptions.defaultDatabase,
    ProjectConfigOptions.defaultSchema,
    ProjectConfigOptions.defaultLocation,
    ProjectConfigOptions.assertionSchema,
    ProjectConfigOptions.vars,
    ProjectConfigOptions.databaseSuffix,
    ProjectConfigOptions.schemaSuffix,
    ProjectConfigOptions.tablePrefix,
    ProjectConfigOptions.disableAssertions,
    ProjectConfigOptions.defaultReservation,
    ProjectConfigOptions.environment,
  ];

  public static constructProjectConfigOverride(argv: ProjectConfigArgv): sqlanvil.IProjectConfig {
    const projectConfigOptions: sqlanvil.IProjectConfig = {};

    if (argv[ProjectConfigOptions.defaultDatabase.name]) {
      projectConfigOptions.defaultDatabase = argv[ProjectConfigOptions.defaultDatabase.name];
    }
    if (argv[ProjectConfigOptions.defaultSchema.name]) {
      projectConfigOptions.defaultSchema = argv[ProjectConfigOptions.defaultSchema.name];
    }
    if (argv[ProjectConfigOptions.defaultLocation.name]) {
      projectConfigOptions.defaultLocation = argv[ProjectConfigOptions.defaultLocation.name];
    }
    if (argv[ProjectConfigOptions.assertionSchema.name]) {
      projectConfigOptions.assertionSchema = argv[ProjectConfigOptions.assertionSchema.name];
    }
    if (argv[ProjectConfigOptions.vars.name]) {
      projectConfigOptions.vars = argv[ProjectConfigOptions.vars.name];
    }
    if (argv[ProjectConfigOptions.databaseSuffix.name]) {
      projectConfigOptions.databaseSuffix = argv[ProjectConfigOptions.databaseSuffix.name];
    }
    if (argv[ProjectConfigOptions.schemaSuffix.name]) {
      projectConfigOptions.schemaSuffix = argv[ProjectConfigOptions.schemaSuffix.name];
    }
    if (argv[ProjectConfigOptions.tablePrefix.name]) {
      projectConfigOptions.tablePrefix = argv[ProjectConfigOptions.tablePrefix.name];
    }
    if (argv[ProjectConfigOptions.disableAssertions.name]) {
      projectConfigOptions.disableAssertions = argv[ProjectConfigOptions.disableAssertions.name];
    }
    if (argv[ProjectConfigOptions.defaultReservation.name]) {
      projectConfigOptions.defaultReservation = argv[ProjectConfigOptions.defaultReservation.name];
    }
    return projectConfigOptions;
  }
}
