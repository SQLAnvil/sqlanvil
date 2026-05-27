import * as utils from "sa/core/utils";
import { sqlanvil } from "sa/protos/ts";

/**
 * @deprecated
 * Use core.proto config options instead.
 * Describes columns in a dataset.
 */
export interface IColumnsDescriptor {
  [name: string]: string | IRecordDescriptor;
}

/**
 * @deprecated
 * Use core.proto config options instead.
 * Describes a struct, object or record in a dataset that has nested columns.
 */
export interface IRecordDescriptor {
  /**
   * A description of the struct, object or record.
   */
  description?: string;

  /**
   * A description of columns within the struct, object or record.
   */
  columns?: IColumnsDescriptor;

  /**
   * @hidden
   */
  displayName?: string;

  /**
   * Tags that apply to this column (experimental).
   *
   * @hidden
   */
  tags?: string | string[];

  /**
   * BigQuery policy tags that should be applied to this column.
   *
   * These should be the fully qualified identifier of the tag, including the project name, location, and taxonomy,
   * which can be copied from the policy tags page in GCP.
   *
   * For example: "projects/1/locations/eu/taxonomies/2/policyTags/3"
   *
   * Currently BigQuery supports only a single tag per column.
   */
  bigqueryPolicyTags?: string | string[];
}

/**
 * @hidden
 * @deprecated
 * Use core.proto config options instead.
 */
export const IRecordDescriptorProperties = () =>
  utils.strictKeysOf<IRecordDescriptor>()([
    "description",
    "columns",
    "displayName",
    "tags",
    "bigqueryPolicyTags"
  ]);

/**
 * @hidden
 */
export class ColumnDescriptors {
  public static mapConfigProtoToCompilationProto(
    columns: sqlanvil.ActionConfig.ColumnDescriptor[]
  ): sqlanvil.IColumnDescriptor[] {
    return columns.map(column => {
      return sqlanvil.ColumnDescriptor.create({
        path: column.path,
        description: column.description,
        tags: column.tags,
        bigqueryPolicyTags: column.bigqueryPolicyTags
      });
    });
  }

  public static mapLegacyObjectToConfigProto(
    columns: IColumnsDescriptor
  ): sqlanvil.ActionConfig.ColumnDescriptor[] {
    return Object.keys(columns)
      .map(column => ColumnDescriptors.mapColumnDescriptionToProto([column], columns[column]))
      .flat();
  }

  public static mapColumnDescriptionToProto(
    currentPath: string[],
    description: string | IRecordDescriptor
  ): sqlanvil.ActionConfig.ColumnDescriptor[] {
    if (typeof description === "string") {
      return [
        sqlanvil.ColumnDescriptor.create({
          description,
          path: currentPath
        })
      ];
    }
    const columnDescriptor: sqlanvil.ActionConfig.ColumnDescriptor[] = !!description
      ? [
          sqlanvil.ActionConfig.ColumnDescriptor.create({
            path: currentPath,
            description: description.description,
            tags: typeof description.tags === "string" ? [description.tags] : description.tags,
            bigqueryPolicyTags:
              typeof description.bigqueryPolicyTags === "string"
                ? [description.bigqueryPolicyTags]
                : description.bigqueryPolicyTags
          })
        ]
      : [];
    const nestedColumns = description.columns ? Object.keys(description.columns) : [];
    return columnDescriptor.concat(
      nestedColumns
        .map(nestedColumn =>
          ColumnDescriptors.mapColumnDescriptionToProto(
            currentPath.concat([nestedColumn]),
            description.columns[nestedColumn]
          )
        )
        .flat()
    );
  }
}

/**
 * @hidden
 */
export class LegacyColumnDescriptors {
  public static mapToColumnProtoArray(
    columns: IColumnsDescriptor,
    reportError: (e: Error) => void
  ): sqlanvil.IColumnDescriptor[] {
    return Object.keys(columns)
      .map(column =>
        LegacyColumnDescriptors.mapColumnDescriptionToProto([column], columns[column], reportError)
      )
      .flat();
  }

  public static mapColumnDescriptionToProto(
    currentPath: string[],
    description: string | IRecordDescriptor,
    reportError: (e: Error) => void
  ): sqlanvil.IColumnDescriptor[] {
    if (typeof description === "string") {
      return [
        sqlanvil.ColumnDescriptor.create({
          description,
          path: currentPath
        })
      ];
    }
    utils.checkExcessProperties(
      reportError,
      description,
      IRecordDescriptorProperties(),
      `${currentPath.join(".")} column descriptor`
    );
    const columnDescriptor: sqlanvil.IColumnDescriptor[] = !!description
      ? [
          sqlanvil.ColumnDescriptor.create({
            path: currentPath,
            description: description.description,
            displayName: description.displayName,
            tags: typeof description.tags === "string" ? [description.tags] : description.tags,
            bigqueryPolicyTags:
              typeof description.bigqueryPolicyTags === "string"
                ? [description.bigqueryPolicyTags]
                : description.bigqueryPolicyTags
          })
        ]
      : [];
    const nestedColumns = description.columns ? Object.keys(description.columns) : [];
    return columnDescriptor.concat(
      nestedColumns
        .map(nestedColumn =>
          LegacyColumnDescriptors.mapColumnDescriptionToProto(
            currentPath.concat([nestedColumn]),
            description.columns[nestedColumn],
            reportError
          )
        )
        .flat()
    );
  }
}
