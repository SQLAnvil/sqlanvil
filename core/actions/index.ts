import { Assertion } from "sa/core/actions/assertion";
import { DataPreparation } from "sa/core/actions/data_preparation";
import { Declaration } from "sa/core/actions/declaration";
import { Export } from "sa/core/actions/export";
import { Import } from "sa/core/actions/import";
import { IncrementalTable } from "sa/core/actions/incremental_table";
import { Notebook } from "sa/core/actions/notebook";
import { Operation } from "sa/core/actions/operation";
import { Table } from "sa/core/actions/table";
import { Test } from "sa/core/actions/test";
import { View } from "sa/core/actions/view";
import { RlsPolicy } from "sa/core/actions/rls_policy";
import { RealtimePublication } from "sa/core/actions/realtime_publication";
import { Wrapper } from "sa/core/actions/wrapper";
import { ForeignTable } from "sa/core/actions/foreign_table";
import { VectorIndex } from "sa/core/actions/vector_index";
import { IColumnsDescriptor } from "sa/core/column_descriptors";
import { Resolvable } from "sa/core/contextables";
import { Session } from "sa/core/session";
import { sqlanvil } from "sa/protos/ts";

export { RlsPolicy, IRlsPolicyConfig } from "sa/core/actions/rls_policy";
export { RealtimePublication, IRealtimePublicationConfig } from "sa/core/actions/realtime_publication";
export { Wrapper, IWrapperConfig } from "sa/core/actions/wrapper";
export { ForeignTable, IForeignTableConfig } from "sa/core/actions/foreign_table";
export { VectorIndex, IVectorIndexConfig } from "sa/core/actions/vector_index";

export type Action =
  | Table
  | View
  | IncrementalTable
  | Operation
  | Assertion
  | Declaration
  | Notebook
  | DataPreparation
  | Export
  | Import
  | Test
  | RlsPolicy
  | RealtimePublication
  | Wrapper
  | ForeignTable
  | VectorIndex;

export type ActionProto =
  | sqlanvil.Table // core.proto's Table represents the Table, View or IncrementalTable action type.
  | sqlanvil.Operation
  | sqlanvil.Assertion
  | sqlanvil.Declaration
  | sqlanvil.Notebook
  | sqlanvil.DataPreparation
  | sqlanvil.Export
  | sqlanvil.Import
  | sqlanvil.Test;

export { ActionBuilder } from "sa/core/actions/base";

export function checkConfigAdditionalOptionsOverlap(
  config: sqlanvil.ActionConfig.TableConfig | sqlanvil.ActionConfig.IncrementalTableConfig,
  session: Session
) {
  const target = sqlanvil.Target.create({
    database: config.project,
    schema: config.dataset,
    name: config.name
  });
  if (config.partitionExpirationDays && config.additionalOptions.partition_expiration_days) {
    session.compileError(
      `partitionExpirationDays has been declared twice`,
      config.filename,
      target
    );
  }
  if (config.requirePartitionFilter && config.additionalOptions.require_partition_filter) {
    session.compileError(`requirePartitionFilter has been declared twice`, config.filename, target);
  }
}

/**
 * @hidden
 * @deprecated
 * Use core.proto config options instead.
 */
export interface INamedConfig {
  /**
   * The type of the action.
   *
   * @hidden
   */
  type?: string;

  /**
   * The name of the action.
   *
   * @hidden
   */
  name?: string;
}

/**
 * @hidden
 * @deprecated
 * Use core.proto config options instead.
 */
export interface IActionConfig {
  /**
   * A list of user-defined tags with which the action should be labeled.
   */
  tags?: string[];

  /**
   * Dependencies of the action.
   *
   * @hidden
   */
  dependencies?: Resolvable | Resolvable[];

  /**
   * If set to true, this action will not be executed. However, the action may still be depended upon.
   * Useful for temporarily turning off broken actions.
   */
  disabled?: boolean;
}

/**
 * @hidden
 * @deprecated
 * Use core.proto config options instead.
 */
export interface ITargetableConfig {
  /**
   * The database in which the output of this action should be created.
   */
  database?: string;

  /**
   * The schema in which the output of this action should be created.
   */
  schema?: string;
}

/**
 * @hidden
 * @deprecated
 * Use core.proto config options instead.
 */
export interface IDependenciesConfig {
  /**
   * One or more explicit dependencies for this action. Dependency actions will run before dependent actions.
   * Typically this would remain unset, because most dependencies are declared as a by-product of using the `ref` function.
   */
  dependencies?: Resolvable | Resolvable[];

  /**
   * Declares whether or not this action is hermetic. An action is hermetic if all of its dependencies are explicitly
   * declared.
   *
   * If this action depends on data from a source which has not been declared as a dependency, then `hermetic`
   * should be explicitly set to `false`. Otherwise, if this action only depends on data from explicitly-declared
   * dependencies, then it should be set to `true`.
   */
  hermetic?: boolean;

  /**
   * If this flag is set to true, assertions dependent upon any of the dependencies are added as dependencies as well.
   */
  dependOnDependencyAssertions?: boolean;
}

/**
 * @hidden
 * @deprecated
 * Use core.proto config options instead.
 */
export interface IDocumentableConfig {
  /**
   * A description of columns within the dataset.
   */
  columns?: IColumnsDescriptor;

  /**
   * A description of the dataset.
   */
  description?: string;
}

/**
 * @hidden
 * @deprecated
 * This is no longer needed other than for legacy backwards compatibility purposes, as tables are
 * now configured in separate actions.
 */
export type TableType = typeof TableType[number];

/**
 * @hidden
 * @deprecated
 * This is no longer needed other than for legacy backwards compatibility purposes, as tables are
 * now configured in separate actions.
 */
export const TableType = ["table", "view", "incremental"] as const;

/**
 * @hidden
 * @deprecated
 * These options are only here to preserve backwards compatibility of legacy config options.
 * consider breaking backwards compatability of this in v4.
 */
export interface ILegacyTableConfig
  extends IActionConfig,
    IDependenciesConfig,
    IDocumentableConfig,
    INamedConfig,
    ITargetableConfig {
  type?: TableType;
  protected?: boolean;
  bigquery?: ILegacyBigQueryOptions;
  assertions?: ILegacyTableAssertions;
  uniqueKey?: string[];
  materialized?: boolean;
}

/**
 * @hidden
 * @deprecated
 * These options are only here to preserve backwards compatibility of legacy config options.
 * consider breaking backwards compatability of this in v4.
 */
export interface ILegacyBigQueryOptions {
  partitionBy?: string;
  clusterBy?: string[];
  updatePartitionFilter?: string;
  labels?: { [name: string]: string };
  partitionExpirationDays?: number;
  requirePartitionFilter?: boolean;
  additionalOptions?: { [name: string]: string };
  iceberg?: {
    fileFormat?: string;
    tableFormat?: string;
    connection?: string;
    bucketName?: string;
    tableFolderRoot?: string;
    tableFolderSubpath?: string;
  }
}

/**
 * @hidden
 * @deprecated
 * These options are only here to preserve backwards compatibility of legacy config options.
 * consider breaking backwards compatability of this in v4.
 */
export interface ILegacyTableAssertions {
  uniqueKey?: string | string[];
  uniqueKeys?: string[][];
  nonNull?: string | string[];
  rowConditions?: string[];
}

export class LegacyConfigConverter {
  // This is a workaround to make bigquery options output empty fields with the same behaviour as
  // they did previously.
  public static legacyConvertBigQueryOptions(
    bigquery: sqlanvil.IBigQueryOptions
  ): sqlanvil.IBigQueryOptions {
    let bigqueryFiltered: sqlanvil.IBigQueryOptions = {};
    Object.entries(bigquery).forEach(([key, value]) => {
      if (Array.isArray(value) && value.length === 0) {
        return;
      } else if (typeof value === "object" && Object.entries(value).length === 0) {
        return;
      }
      if (value) {
        bigqueryFiltered = {
          ...bigqueryFiltered,
          [key]: value
        };
      }
    });
    return bigqueryFiltered;
  }

  public static insertLegacyInlineAssertionsToConfigProto<T extends ILegacyTableConfig>(
    unverifiedConfig: T
  ): T {
    // Type `any` is used here to facilitate the type hacking for legacy compatibility.
    const legacyConfig: any = unverifiedConfig;
    if (legacyConfig?.assertions) {
      if (typeof legacyConfig.assertions?.uniqueKey === "string") {
        legacyConfig.assertions.uniqueKey = [legacyConfig.assertions.uniqueKey];
      }
      // This determines if the uniqueKeys is of the legacy type.
      if (legacyConfig.assertions.uniqueKeys?.[0]?.length > 0) {
        legacyConfig.assertions.uniqueKeys = (legacyConfig.assertions
          .uniqueKeys as string[][]).map(uniqueKey =>
          sqlanvil.ActionConfig.TableAssertionsConfig.UniqueKey.create({ uniqueKey })
        );
      }
      if (typeof legacyConfig.assertions.nonNull === "string") {
        legacyConfig.assertions.nonNull = [legacyConfig.assertions.nonNull];
      }
    }
    return legacyConfig;
  }

  public static insertLegacyBigQueryOptionsToConfigProto<T extends ILegacyTableConfig>(
    unverifiedConfig: T
  ): T {
    // Type `any` is used here to facilitate the type hacking for legacy compatibility.
    const legacyConfig: any = unverifiedConfig;
    if (!legacyConfig?.bigquery) {
      return legacyConfig;
    }
    if (!!legacyConfig.bigquery.partitionBy) {
      legacyConfig.partitionBy = legacyConfig.bigquery.partitionBy;
      delete legacyConfig.bigquery.partitionBy;
    }
    if (!!legacyConfig.bigquery.clusterBy) {
      legacyConfig.clusterBy = legacyConfig.bigquery.clusterBy;
      delete legacyConfig.bigquery.clusterBy;
    }
    if (!!legacyConfig.bigquery.updatePartitionFilter) {
      legacyConfig.updatePartitionFilter = legacyConfig.bigquery.updatePartitionFilter;
      delete legacyConfig.bigquery.updatePartitionFilter;
    }
    if (!!legacyConfig.bigquery.labels) {
      legacyConfig.labels = legacyConfig.bigquery.labels;
      delete legacyConfig.bigquery.labels;
    }
    if (!!legacyConfig.bigquery.partitionExpirationDays) {
      legacyConfig.partitionExpirationDays = legacyConfig.bigquery.partitionExpirationDays;
      delete legacyConfig.bigquery.partitionExpirationDays;
    }
    if (!!legacyConfig.bigquery.requirePartitionFilter) {
      legacyConfig.requirePartitionFilter = legacyConfig.bigquery.requirePartitionFilter;
      delete legacyConfig.bigquery.requirePartitionFilter;
    }
    if (!!legacyConfig.bigquery.additionalOptions) {
      legacyConfig.additionalOptions = legacyConfig.bigquery.additionalOptions;
      delete legacyConfig.bigquery.additionalOptions;
    }
    if(!!legacyConfig.bigquery.iceberg) {
      legacyConfig.iceberg = legacyConfig.bigquery.iceberg;
      delete legacyConfig.bigquery.iceberg;
    }
    // To prevent skipping throwing an error when there are additional, unused fields, only delete
    // the legacy bigquery object if there are no more fields left on it.
    if (Object.keys(legacyConfig.bigquery).length === 0) {
      delete legacyConfig.bigquery;
    }
    return legacyConfig;
  }
}
