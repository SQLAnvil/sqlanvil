# Protocol Documentation

<a name="top"></a>

## Table of Contents

- [configs.proto](#configs-proto)

  - [ActionConfig](#sqlanvil-ActionConfig)
  - [ActionConfig.AssertionConfig](#sqlanvil-ActionConfig-AssertionConfig)
  - [ActionConfig.ColumnDescriptor](#sqlanvil-ActionConfig-ColumnDescriptor)
  - [ActionConfig.DataPreparationConfig](#sqlanvil-ActionConfig-DataPreparationConfig)
  - [ActionConfig.DeclarationConfig](#sqlanvil-ActionConfig-DeclarationConfig)
  - [ActionConfig.IncrementalTableConfig](#sqlanvil-ActionConfig-IncrementalTableConfig)
  - [ActionConfig.IncrementalTableConfig.AdditionalOptionsEntry](#sqlanvil-ActionConfig-IncrementalTableConfig-AdditionalOptionsEntry)
  - [ActionConfig.IncrementalTableConfig.LabelsEntry](#sqlanvil-ActionConfig-IncrementalTableConfig-LabelsEntry)
  - [ActionConfig.NotebookConfig](#sqlanvil-ActionConfig-NotebookConfig)
  - [ActionConfig.OnSchemaChange](#sqlanvil-ActionConfig-OnSchemaChange)
  - [ActionConfig.OperationConfig](#sqlanvil-ActionConfig-OperationConfig)
  - [ActionConfig.TableAssertionsConfig](#sqlanvil-ActionConfig-TableAssertionsConfig)
  - [ActionConfig.TableAssertionsConfig.UniqueKey](#sqlanvil-ActionConfig-TableAssertionsConfig-UniqueKey)
  - [ActionConfig.TableConfig](#sqlanvil-ActionConfig-TableConfig)
  - [ActionConfig.TableConfig.AdditionalOptionsEntry](#sqlanvil-ActionConfig-TableConfig-AdditionalOptionsEntry)
  - [ActionConfig.TableConfig.LabelsEntry](#sqlanvil-ActionConfig-TableConfig-LabelsEntry)
  - [ActionConfig.Target](#sqlanvil-ActionConfig-Target)
  - [ActionConfig.ViewConfig](#sqlanvil-ActionConfig-ViewConfig)
  - [ActionConfig.ViewConfig.AdditionalOptionsEntry](#sqlanvil-ActionConfig-ViewConfig-AdditionalOptionsEntry)
  - [ActionConfig.ViewConfig.LabelsEntry](#sqlanvil-ActionConfig-ViewConfig-LabelsEntry)
  - [ActionConfigs](#sqlanvil-ActionConfigs)
  - [NotebookRuntimeOptionsConfig](#sqlanvil-NotebookRuntimeOptionsConfig)
  - [WorkflowSettings](#sqlanvil-WorkflowSettings)
  - [WorkflowSettings.VarsEntry](#sqlanvil-WorkflowSettings-VarsEntry)

- [Scalar Value Types](#scalar-value-types)

<a name="configs-proto"></a>

<p align="right"><a href="#top">Top</a></p>

## configs.proto

<a name="sqlanvil-ActionConfig"></a>

### ActionConfig

Action config defines the contents of `actions.yaml` configuration files.

| Field            | Type                                                                                 | Label | Description |
| ---------------- | ------------------------------------------------------------------------------------ | ----- | ----------- |
| table            | [ActionConfig.TableConfig](#sqlanvil-ActionConfig-TableConfig)                       |       |             |
| view             | [ActionConfig.ViewConfig](#sqlanvil-ActionConfig-ViewConfig)                         |       |             |
| incrementalTable | [ActionConfig.IncrementalTableConfig](#sqlanvil-ActionConfig-IncrementalTableConfig) |       |             |
| assertion        | [ActionConfig.AssertionConfig](#sqlanvil-ActionConfig-AssertionConfig)               |       |             |
| operation        | [ActionConfig.OperationConfig](#sqlanvil-ActionConfig-OperationConfig)               |       |             |
| declaration      | [ActionConfig.DeclarationConfig](#sqlanvil-ActionConfig-DeclarationConfig)           |       |             |
| notebook         | [ActionConfig.NotebookConfig](#sqlanvil-ActionConfig-NotebookConfig)                 |       |             |
| dataPreparation  | [ActionConfig.DataPreparationConfig](#sqlanvil-ActionConfig-DataPreparationConfig)   |       |             |

<a name="sqlanvil-ActionConfig-AssertionConfig"></a>

### ActionConfig.AssertionConfig

| Field                        | Type                                                 | Label    | Description                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                         | [string](#string)                                    |          | The name of the assertion.                                                                                                                                                                                                      |
| dataset                      | [string](#string)                                    |          | The dataset (schema) of the assertion.                                                                                                                                                                                          |
| project                      | [string](#string)                                    |          | The Google Cloud project (database) of the assertion.                                                                                                                                                                           |
| dependencyTargets            | [ActionConfig.Target](#sqlanvil-ActionConfig-Target) | repeated | Targets of actions that this action is dependent on.                                                                                                                                                                            |
| filename                     | [string](#string)                                    |          | Path to the source file that the contents of the action is loaded from.                                                                                                                                                         |
| tags                         | [string](#string)                                    | repeated | A list of user-defined tags with which the action should be labeled.                                                                                                                                                            |
| disabled                     | [bool](#bool)                                        |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions.                                                                            |
| description                  | [string](#string)                                    |          | Description of the assertion.                                                                                                                                                                                                   |
| hermetic                     | [bool](#bool)                                        |          | If true, this indicates that the action only depends on data from explicitly-declared dependencies. Otherwise if false, it indicates that the action depends on data from a source which has not been declared as a dependency. |
| dependOnDependencyAssertions | [bool](#bool)                                        |          | If true, assertions dependent upon any of the dependencies are added as dependencies as well.                                                                                                                                   |
| reservation          | [string](#string)                                    |          | Optional. The BigQuery reservation to use for execution.                                                                                                                                                                        |

<a name="sqlanvil-ActionConfig-ColumnDescriptor"></a>

### ActionConfig.ColumnDescriptor

| Field              | Type              | Label    | Description                                                             |
| ------------------ | ----------------- | -------- | ----------------------------------------------------------------------- |
| path               | [string](#string) | repeated | The identifier for the column, using multiple parts for nested records. |
| description        | [string](#string) |          | A text description of the column.                                       |
| bigqueryPolicyTags | [string](#string) | repeated | A list of BigQuery policy tags that will be applied to the column.      |
| tags               | [string](#string) | repeated | A list of tags for this column which will be applied.                   |

<a name="sqlanvil-ActionConfig-DataPreparationConfig"></a>

### ActionConfig.DataPreparationConfig

| Field               | Type                                                 | Label    | Description                                                                                                                                          |
| ------------------- | ---------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                | [string](#string)                                    |          | The name of the data preparation.                                                                                                                    |
| dependencyTargets   | [ActionConfig.Target](#sqlanvil-ActionConfig-Target) | repeated | Targets of actions that this action is dependent on.                                                                                                 |
| filename            | [string](#string)                                    |          | Path to the source file that the contents of the action is loaded from.                                                                              |
| tags                | [string](#string)                                    | repeated | A list of user-defined tags with which the action should be labeled.                                                                                 |
| disabled            | [bool](#bool)                                        |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions. |
| description         | [string](#string)                                    |          | Description of the data preparation.                                                                                                                 |
| reservation | [string](#string)                                    |          | Optional. The BigQuery reservation to use for execution.                                                                                             |

<a name="sqlanvil-ActionConfig-DeclarationConfig"></a>

### ActionConfig.DeclarationConfig

| Field       | Type                                                                     | Label    | Description                                             |
| ----------- | ------------------------------------------------------------------------ | -------- | ------------------------------------------------------- |
| name        | [string](#string)                                                        |          | The name of the declaration.                            |
| dataset     | [string](#string)                                                        |          | The dataset (schema) of the declaration.                |
| project     | [string](#string)                                                        |          | The Google Cloud project (database) of the declaration. |
| description | [string](#string)                                                        |          | Description of the declaration.                         |
| columns     | [ActionConfig.ColumnDescriptor](#sqlanvil-ActionConfig-ColumnDescriptor) | repeated | Descriptions of columns within the declaration.         |

<a name="sqlanvil-ActionConfig-IncrementalTableConfig"></a>

### ActionConfig.IncrementalTableConfig

| Field                        | Type                                                                                                                               | Label    | Description                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                         | [string](#string)                                                                                                                  |          | The name of the incremental table.                                                                                                                                                                                              |
| dataset                      | [string](#string)                                                                                                                  |          | The dataset (schema) of the incremental table.                                                                                                                                                                                  |
| project                      | [string](#string)                                                                                                                  |          | The Google Cloud project (database) of the incremental table.                                                                                                                                                                   |
| dependencyTargets            | [ActionConfig.Target](#sqlanvil-ActionConfig-Target)                                                                               | repeated | Targets of actions that this action is dependent on.                                                                                                                                                                            |
| filename                     | [string](#string)                                                                                                                  |          | Path to the source file that the contents of the action is loaded from.                                                                                                                                                         |
| tags                         | [string](#string)                                                                                                                  | repeated | A list of user-defined tags with which the action should be labeled.                                                                                                                                                            |
| disabled                     | [bool](#bool)                                                                                                                      |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions.                                                                            |
| preOperations                | [string](#string)                                                                                                                  | repeated | Queries to run before `query`. This can be useful for granting permissions.                                                                                                                                                     |
| postOperations               | [string](#string)                                                                                                                  | repeated | Queries to run after `query`.                                                                                                                                                                                                   |
| protected                    | [bool](#bool)                                                                                                                      |          | If true, prevents the dataset from being rebuilt from scratch.                                                                                                                                                                  |
| uniqueKey                    | [string](#string)                                                                                                                  | repeated | If set, unique key represents a set of names of columns that will act as a the unique key. To enforce this, when updating the incremental table, sqlanvil merges rows with `uniqueKey` instead of appending them.               |
| description                  | [string](#string)                                                                                                                  |          | Description of the incremental table.                                                                                                                                                                                           |
| columns                      | [ActionConfig.ColumnDescriptor](#sqlanvil-ActionConfig-ColumnDescriptor)                                                           | repeated | Descriptions of columns within the table.                                                                                                                                                                                       |
| partitionBy                  | [string](#string)                                                                                                                  |          | The key by which to partition the table. Typically the name of a timestamp or the date column. See https://cloud.google.com/dataform/docs/partitions-clusters.                                                                  |
| partitionExpirationDays      | [int32](#int32)                                                                                                                    |          | The number of days for which BigQuery stores data in each partition. The setting applies to all partitions in a table, but is calculated independently for each partition based on the partition time.                          |
| requirePartitionFilter       | [bool](#bool)                                                                                                                      |          | Declares whether the partitioned table requires a WHERE clause predicate filter that filters the partitioning column.                                                                                                           |
| updatePartitionFilter        | [string](#string)                                                                                                                  |          | SQL-based filter for when incremental updates are applied.                                                                                                                                                                      |
| clusterBy                    | [string](#string)                                                                                                                  | repeated | The keys by which to cluster partitions by. See https://cloud.google.com/dataform/docs/partitions-clusters.                                                                                                                     |
| labels                       | [ActionConfig.IncrementalTableConfig.LabelsEntry](#sqlanvil-ActionConfig-IncrementalTableConfig-LabelsEntry)                       | repeated | Key-value pairs for BigQuery labels.                                                                                                                                                                                            |
| additionalOptions            | [ActionConfig.IncrementalTableConfig.AdditionalOptionsEntry](#sqlanvil-ActionConfig-IncrementalTableConfig-AdditionalOptionsEntry) | repeated | Key-value pairs of additional options to pass to the BigQuery API. Some options, for example, partitionExpirationDays, have dedicated type/validity checked fields. For such options, use the dedicated fields.                 |
| dependOnDependencyAssertions | [bool](#bool)                                                                                                                      |          | When set to true, assertions dependent upon any dependency will be add as dedpendency to this action                                                                                                                            |
| assertions                   | [ActionConfig.TableAssertionsConfig](#sqlanvil-ActionConfig-TableAssertionsConfig)                                                 |          | Assertions to be run on the dataset. If configured, relevant assertions will automatically be created and run as a dependency of this dataset.                                                                                  |
| hermetic                     | [bool](#bool)                                                                                                                      |          | If true, this indicates that the action only depends on data from explicitly-declared dependencies. Otherwise if false, it indicates that the action depends on data from a source which has not been declared as a dependency. |
| onSchemaChange               | [ActionConfg.OnSchemaChange](#sqlanvil-ActionConfig-OnSchemaChange)                                                                |          | Defines the action behavior if the selected columns in query doesn't match columns in the target table.                                                                                                                         |
| reservation          | [string](#string)                                                                                                                  |          | Optional. The BigQuery reservation to use for execution.                                                                                                                                                                        |

<a name="sqlanvil-ActionConfig-IncrementalTableConfig-AdditionalOptionsEntry"></a>

### ActionConfig.IncrementalTableConfig.AdditionalOptionsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

<a name="sqlanvil-ActionConfig-IncrementalTableConfig-LabelsEntry"></a>

### ActionConfig.IncrementalTableConfig.LabelsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

<a name="sqlanvil-ActionConfig-NotebookConfig"></a>

### ActionConfig.NotebookConfig

| Field                        | Type                                                 | Label    | Description                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                         | [string](#string)                                    |          | The name of the notebook.                                                                                                                            |
| location                     | [string](#string)                                    |          | The Google Cloud location of the notebook.                                                                                                           |
| project                      | [string](#string)                                    |          | The Google Cloud project (database) of the notebook.                                                                                                 |
| dependencyTargets            | [ActionConfig.Target](#sqlanvil-ActionConfig-Target) | repeated | Targets of actions that this action is dependent on.                                                                                                 |
| filename                     | [string](#string)                                    |          | Path to the source file that the contents of the action is loaded from.                                                                              |
| tags                         | [string](#string)                                    | repeated | A list of user-defined tags with which the action should be labeled.                                                                                 |
| disabled                     | [bool](#bool)                                        |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions. |
| description                  | [string](#string)                                    |          | Description of the notebook.                                                                                                                         |
| dependOnDependencyAssertions | [bool](#bool)                                        |          | When set to true, assertions dependent upon any dependency will be add as dedpendency to this action                                                 |
| reservation          | [string](#string)                                    |          | Optional. The BigQuery reservation to use for execution.                                                                                             |

<a name="sqlanvil-ActionConfig-OnSchemaChange"></a>

### ActionConfig.OnSchemaChange

| Value       | Description                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| IGNORE      | New columns are ignored. Fails if columns are deleted or renamed. _Default value_.                                                    |
| FAIL        | Fails if the query would result in a new column(s) being added, deleted, or renamed.                                                  |
| EXTEND      | New columns will be added to the target table. Fails if columns are deleted or renamed.                                               |
| SYNCHRONIZE | Does not block any new column(s) from being added, deleted or renamed. Partitioned or clustered columns cannot be deleted or renamed. |

<a name="sqlanvil-ActionConfig-OperationConfig"></a>

### ActionConfig.OperationConfig

| Field                        | Type                                                                     | Label    | Description                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                         | [string](#string)                                                        |          | The name of the operation.                                                                                                                                                                                                      |
| dataset                      | [string](#string)                                                        |          | The dataset (schema) of the operation.                                                                                                                                                                                          |
| project                      | [string](#string)                                                        |          | The Google Cloud project (database) of the operation.                                                                                                                                                                           |
| dependencyTargets            | [ActionConfig.Target](#sqlanvil-ActionConfig-Target)                     | repeated | Targets of actions that this action is dependent on.                                                                                                                                                                            |
| filename                     | [string](#string)                                                        |          | Path to the source file that the contents of the action is loaded from.                                                                                                                                                         |
| tags                         | [string](#string)                                                        | repeated | A list of user-defined tags with which the action should be labeled.                                                                                                                                                            |
| disabled                     | [bool](#bool)                                                            |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions.                                                                            |
| hasOutput                    | [bool](#bool)                                                            |          | Declares that this action creates a dataset which should be referenceable as a dependency target, for example by using the `ref` function.                                                                                      |
| description                  | [string](#string)                                                        |          | Description of the operation.                                                                                                                                                                                                   |
| columns                      | [ActionConfig.ColumnDescriptor](#sqlanvil-ActionConfig-ColumnDescriptor) | repeated | Descriptions of columns within the operation. Can only be set if hasOutput is true.                                                                                                                                             |
| dependOnDependencyAssertions | [bool](#bool)                                                            |          | When set to true, assertions dependent upon any dependency will be add as dedpendency to this action                                                                                                                            |
| hermetic                     | [bool](#bool)                                                            |          | If true, this indicates that the action only depends on data from explicitly-declared dependencies. Otherwise if false, it indicates that the action depends on data from a source which has not been declared as a dependency. |
| reservation          | [string](#string)                                                        |          | Optional. The BigQuery reservation to use for execution.                                                                                                                                                                        |

<a name="sqlanvil-ActionConfig-TableAssertionsConfig"></a>

### ActionConfig.TableAssertionsConfig

Options for shorthand specifying assertions, useable for some table-based
action types.

| Field         | Type                                                                                                   | Label    | Description                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| uniqueKey     | [string](#string)                                                                                      | repeated | Column(s) which constitute the dataset&#39;s unique key index. If set, the resulting assertion will fail if there is more than one row in the dataset with the same values for all of these column(s). |
| uniqueKeys    | [ActionConfig.TableAssertionsConfig.UniqueKey](#sqlanvil-ActionConfig-TableAssertionsConfig-UniqueKey) | repeated |                                                                                                                                                                                                        |
| nonNull       | [string](#string)                                                                                      | repeated | Column(s) which may never be `NULL`. If set, the resulting assertion will fail if any row contains `NULL` values for these column(s).                                                                  |
| rowConditions | [string](#string)                                                                                      | repeated | General condition(s) which should hold true for all rows in the dataset. If set, the resulting assertion will fail if any row violates any of these condition(s).                                      |

<a name="sqlanvil-ActionConfig-TableAssertionsConfig-UniqueKey"></a>

### ActionConfig.TableAssertionsConfig.UniqueKey

Combinations of column(s), each of which should constitute a unique key
index for the dataset. If set, the resulting assertion(s) will fail if
there is more than one row in the dataset with the same values for all of
the column(s) in the unique key(s).

| Field     | Type              | Label    | Description |
| --------- | ----------------- | -------- | ----------- |
| uniqueKey | [string](#string) | repeated |             |

<a name="sqlanvil-ActionConfig-TableConfig"></a>

### ActionConfig.TableConfig

| Field                        | Type                                                                                                         | Label    | Description                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                         | [string](#string)                                                                                            |          | The name of the table.                                                                                                                                                                                                          |
| dataset                      | [string](#string)                                                                                            |          | The dataset (schema) of the table.                                                                                                                                                                                              |
| project                      | [string](#string)                                                                                            |          | The Google Cloud project (database) of the table.                                                                                                                                                                               |
| dependencyTargets            | [ActionConfig.Target](#sqlanvil-ActionConfig-Target)                                                         | repeated | Targets of actions that this action is dependent on.                                                                                                                                                                            |
| filename                     | [string](#string)                                                                                            |          | Path to the source file that the contents of the action is loaded from.                                                                                                                                                         |
| tags                         | [string](#string)                                                                                            | repeated | A list of user-defined tags with which the action should be labeled.                                                                                                                                                            |
| disabled                     | [bool](#bool)                                                                                                |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions.                                                                            |
| preOperations                | [string](#string)                                                                                            | repeated | Queries to run before `query`. This can be useful for granting permissions.                                                                                                                                                     |
| postOperations               | [string](#string)                                                                                            | repeated | Queries to run after `query`.                                                                                                                                                                                                   |
| description                  | [string](#string)                                                                                            |          | Description of the table.                                                                                                                                                                                                       |
| columns                      | [ActionConfig.ColumnDescriptor](#sqlanvil-ActionConfig-ColumnDescriptor)                                     | repeated | Descriptions of columns within the table.                                                                                                                                                                                       |
| partitionBy                  | [string](#string)                                                                                            |          | The key by which to partition the table. Typically the name of a timestamp or the date column. See https://cloud.google.com/dataform/docs/partitions-clusters.                                                                  |
| partitionExpirationDays      | [int32](#int32)                                                                                              |          | The number of days for which BigQuery stores data in each partition. The setting applies to all partitions in a table, but is calculated independently for each partition based on the partition time.                          |
| requirePartitionFilter       | [bool](#bool)                                                                                                |          | Declares whether the partitioned table requires a WHERE clause predicate filter that filters the partitioning column.                                                                                                           |
| clusterBy                    | [string](#string)                                                                                            | repeated | The keys by which to cluster partitions by. See https://cloud.google.com/dataform/docs/partitions-clusters.                                                                                                                     |
| labels                       | [ActionConfig.TableConfig.LabelsEntry](#sqlanvil-ActionConfig-TableConfig-LabelsEntry)                       | repeated | Key-value pairs for BigQuery labels.                                                                                                                                                                                            |
| additionalOptions            | [ActionConfig.TableConfig.AdditionalOptionsEntry](#sqlanvil-ActionConfig-TableConfig-AdditionalOptionsEntry) | repeated | Key-value pairs of additional options to pass to the BigQuery API. Some options, for example, partitionExpirationDays, have dedicated type/validity checked fields. For such options, use the dedicated fields.                 |
| dependOnDependencyAssertions | [bool](#bool)                                                                                                |          | When set to true, assertions dependent upon any dependency will be add as dedpendency to this action                                                                                                                            |
| assertions                   | [ActionConfig.TableAssertionsConfig](#sqlanvil-ActionConfig-TableAssertionsConfig)                           |          | Assertions to be run on the dataset. If configured, relevant assertions will automatically be created and run as a dependency of this dataset.                                                                                  |
| hermetic                     | [bool](#bool)                                                                                                |          | If true, this indicates that the action only depends on data from explicitly-declared dependencies. Otherwise if false, it indicates that the action depends on data from a source which has not been declared as a dependency. |
| reservation          | [string](#string)                                                                                            |          | Optional. The BigQuery reservation to use for execution.                                                                                                                                                                        |

<a name="sqlanvil-ActionConfig-TableConfig-AdditionalOptionsEntry"></a>

### ActionConfig.TableConfig.AdditionalOptionsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

<a name="sqlanvil-ActionConfig-TableConfig-LabelsEntry"></a>

### ActionConfig.TableConfig.LabelsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

<a name="sqlanvil-ActionConfig-Target"></a>

### ActionConfig.Target

Target represents a unique action identifier.

| Field                      | Type              | Label | Description                                                                               |
| -------------------------- | ----------------- | ----- | ----------------------------------------------------------------------------------------- |
| project                    | [string](#string) |       | The Google Cloud project (database) of the action.                                        |
| dataset                    | [string](#string) |       | The dataset (schema) of the action. For notebooks, this is the location.                  |
| name                       | [string](#string) |       | The name of the action.                                                                   |
| includeDependentAssertions | [bool](#bool)     |       | flag for when we want to add assertions of this dependency in dependency_targets as well. |

<a name="sqlanvil-ActionConfig-ViewConfig"></a>

### ActionConfig.ViewConfig

| Field                        | Type                                                                                                       | Label    | Description                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| name                         | [string](#string)                                                                                          |          | The name of the view.                                                                                                                                                                                                                                           |
| dataset                      | [string](#string)                                                                                          |          | The dataset (schema) of the view.                                                                                                                                                                                                                               |
| project                      | [string](#string)                                                                                          |          | The Google Cloud project (database) of the view.                                                                                                                                                                                                                |
| dependencyTargets            | [ActionConfig.Target](#sqlanvil-ActionConfig-Target)                                                       | repeated | Targets of actions that this action is dependent on.                                                                                                                                                                                                            |
| filename                     | [string](#string)                                                                                          |          | Path to the source file that the contents of the action is loaded from.                                                                                                                                                                                         |
| tags                         | [string](#string)                                                                                          | repeated | A list of user-defined tags with which the action should be labeled.                                                                                                                                                                                            |
| disabled                     | [bool](#bool)                                                                                              |          | If set to true, this action will not be executed. However, the action can still be depended upon. Useful for temporarily turning off broken actions.                                                                                                            |
| preOperations                | [string](#string)                                                                                          | repeated | Queries to run before `query`. This can be useful for granting permissions.                                                                                                                                                                                     |
| postOperations               | [string](#string)                                                                                          | repeated | Queries to run after `query`.                                                                                                                                                                                                                                   |
| materialized                 | [bool](#bool)                                                                                              |          | Applies the materialized view optimization, see https://cloud.google.com/bigquery/docs/materialized-views-intro.                                                                                                                                                |
| partitionBy                  | [string](#string)                                                                                          |          | Optional. Applicable only to materialized view. The key by which to partition the materialized view. Typically the name of a timestamp or the date column. See https://cloud.google.com/bigquery/docs/materialized-views-create#partitioned_materialized_views. |
| clusterBy                    | [string](#string)                                                                                          | repeated | Optional. Applicable only to materialized view. The keys by which to cluster partitions by. See https://cloud.google.com/bigquery/docs/materialized-views-create#cluster_materialized_views.                                                                    |
| description                  | [string](#string)                                                                                          |          | Description of the view.                                                                                                                                                                                                                                        |
| columns                      | [ActionConfig.ColumnDescriptor](#sqlanvil-ActionConfig-ColumnDescriptor)                                   | repeated | Descriptions of columns within the table.                                                                                                                                                                                                                       |
| labels                       | [ActionConfig.ViewConfig.LabelsEntry](#sqlanvil-ActionConfig-ViewConfig-LabelsEntry)                       | repeated | Key-value pairs for BigQuery labels.                                                                                                                                                                                                                            |
| additionalOptions            | [ActionConfig.ViewConfig.AdditionalOptionsEntry](#sqlanvil-ActionConfig-ViewConfig-AdditionalOptionsEntry) | repeated | Key-value pairs of additional options to pass to the BigQuery API. Some options, for example, partitionExpirationDays, have dedicated type/validity checked fields. For such options, use the dedicated fields.                                                 |
| dependOnDependencyAssertions | [bool](#bool)                                                                                              |          | When set to true, assertions dependent upon any dependency will be add as dedpendency to this action                                                                                                                                                            |
| hermetic                     | [bool](#bool)                                                                                              |          | If true, this indicates that the action only depends on data from explicitly-declared dependencies. Otherwise if false, it indicates that the action depends on data from a source which has not been declared as a dependency.                                 |
| assertions                   | [ActionConfig.TableAssertionsConfig](#sqlanvil-ActionConfig-TableAssertionsConfig)                         |          | Assertions to be run on the dataset. If configured, relevant assertions will automatically be created and run as a dependency of this dataset.                                                                                                                  |
| reservation          | [string](#string)                                                                                          |          | Optional. The BigQuery reservation to use for execution.                                                                                                                                                                                                        |

<a name="sqlanvil-ActionConfig-ViewConfig-AdditionalOptionsEntry"></a>

### ActionConfig.ViewConfig.AdditionalOptionsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

<a name="sqlanvil-ActionConfig-ViewConfig-LabelsEntry"></a>

### ActionConfig.ViewConfig.LabelsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

<a name="sqlanvil-ActionConfigs"></a>

### ActionConfigs

Action configs defines the contents of `actions.yaml` configuration files.

| Field   | Type                                   | Label    | Description |
| ------- | -------------------------------------- | -------- | ----------- |
| actions | [ActionConfig](#sqlanvil-ActionConfig) | repeated |             |

<a name="sqlanvil-NotebookRuntimeOptionsConfig"></a>

### NotebookRuntimeOptionsConfig

| Field        | Type              | Label | Description                                                  |
| ------------ | ----------------- | ----- | ------------------------------------------------------------ |
| outputBucket | [string](#string) |       | Storage bucket to output notebooks to after their execution. |

<a name="sqlanvil-WorkflowSettings"></a>

### WorkflowSettings

Workflow Settings defines the contents of the `workflow_settings.yaml`
configuration file.

| Field                         | Type                                                                   | Label    | Description                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sqlanvilCoreVersion           | [string](#string)                                                      |          | The desired sqlanvil core version to compile against.                                                                                                       |
| defaultProject                | [string](#string)                                                      |          | Required. The default Google Cloud project (database).                                                                                                      |
| defaultDataset                | [string](#string)                                                      |          | Required. The default dataset (schema).                                                                                                                     |
| defaultLocation               | [string](#string)                                                      |          | Required. The default BigQuery location to use. For more information on BigQuery locations, see https://cloud.google.com/bigquery/docs/locations.           |
| defaultAssertionDataset       | [string](#string)                                                      |          | Required. The default dataset (schema) for assertions.                                                                                                      |
| vars                          | [WorkflowSettings.VarsEntry](#sqlanvil-WorkflowSettings-VarsEntry)     | repeated | Optional. User-defined variables that are made available to project code during compilation. An object containing a list of &#34;key&#34;: value pairs.     |
| projectSuffix                 | [string](#string)                                                      |          | Optional. The suffix to append to all Google Cloud project references.                                                                                      |
| datasetSuffix                 | [string](#string)                                                      |          | Optional. The suffix to append to all dataset references.                                                                                                   |
| namePrefix                    | [string](#string)                                                      |          | Optional. The prefix to append to all action names.                                                                                                         |
| defaultNotebookRuntimeOptions | [NotebookRuntimeOptionsConfig](#sqlanvil-NotebookRuntimeOptionsConfig) |          | Optional. Default runtime options for Notebook actions.                                                                                                     |
| builtinAssertionNamePrefix    | [string](#string)                                                      |          | Optional. The prefix to append to built-in assertion names.                                                                                                 |
| defaultReservation            | [string](#string)                                                      |          | Optional. The default BigQuery reservation to use for execution.                                                                                            |

<a name="sqlanvil-WorkflowSettings-VarsEntry"></a>

### WorkflowSettings.VarsEntry

| Field | Type              | Label | Description |
| ----- | ----------------- | ----- | ----------- |
| key   | [string](#string) |       |             |
| value | [string](#string) |       |             |

## Scalar Value Types

| .proto Type                    | Notes                                                                                                                                           | C++    | Java       | Python      | Go      | C#         | PHP            | Ruby                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------- | ------- | ---------- | -------------- | ------------------------------ |
| <a name="double" /> double     |                                                                                                                                                 | double | double     | float       | float64 | double     | float          | Float                          |
| <a name="float" /> float       |                                                                                                                                                 | float  | float      | float       | float32 | float      | float          | Float                          |
| <a name="int32" /> int32       | Uses variable-length encoding. Inefficient for encoding negative numbers – if your field is likely to have negative values, use sint32 instead. | int32  | int        | int         | int32   | int        | integer        | Bignum or Fixnum (as required) |
| <a name="int64" /> int64       | Uses variable-length encoding. Inefficient for encoding negative numbers – if your field is likely to have negative values, use sint64 instead. | int64  | long       | int/long    | int64   | long       | integer/string | Bignum                         |
| <a name="uint32" /> uint32     | Uses variable-length encoding.                                                                                                                  | uint32 | int        | int/long    | uint32  | uint       | integer        | Bignum or Fixnum (as required) |
| <a name="uint64" /> uint64     | Uses variable-length encoding.                                                                                                                  | uint64 | long       | int/long    | uint64  | ulong      | integer/string | Bignum or Fixnum (as required) |
| <a name="sint32" /> sint32     | Uses variable-length encoding. Signed int value. These more efficiently encode negative numbers than regular int32s.                            | int32  | int        | int         | int32   | int        | integer        | Bignum or Fixnum (as required) |
| <a name="sint64" /> sint64     | Uses variable-length encoding. Signed int value. These more efficiently encode negative numbers than regular int64s.                            | int64  | long       | int/long    | int64   | long       | integer/string | Bignum                         |
| <a name="fixed32" /> fixed32   | Always four bytes. More efficient than uint32 if values are often greater than 2^28.                                                            | uint32 | int        | int         | uint32  | uint       | integer        | Bignum or Fixnum (as required) |
| <a name="fixed64" /> fixed64   | Always eight bytes. More efficient than uint64 if values are often greater than 2^56.                                                           | uint64 | long       | int/long    | uint64  | ulong      | integer/string | Bignum                         |
| <a name="sfixed32" /> sfixed32 | Always four bytes.                                                                                                                              | int32  | int        | int         | int32   | int        | integer        | Bignum or Fixnum (as required) |
| <a name="sfixed64" /> sfixed64 | Always eight bytes.                                                                                                                             | int64  | long       | int/long    | int64   | long       | integer/string | Bignum                         |
| <a name="bool" /> bool         |                                                                                                                                                 | bool   | boolean    | boolean     | bool    | bool       | boolean        | TrueClass/FalseClass           |
| <a name="string" /> string     | A string must always contain UTF-8 encoded or 7-bit ASCII text.                                                                                 | string | String     | str/unicode | string  | string     | string         | String (UTF-8)                 |
| <a name="bytes" /> bytes       | May contain any arbitrary sequence of bytes.                                                                                                    | string | ByteString | str         | []byte  | ByteString | string         | String (ASCII-8BIT)            |
