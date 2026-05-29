# Class: Declaration

You can declare any external table as a data source in sqlanvil. Declaring external data
sources that are external to sqlanvil lets you treat those data sources as sqlanvil objects.

Declaring data sources is optional, but can be useful when you want to do the following:
* Reference or resolve declared sources in the same way as any other table in sqlanvil.
* View declared sources in the visualized sqlanvil graph.
* Use sqlanvil to manage the table-level and column-level descriptions of externally created
  tables.
* Trigger workflow invocations that include all the dependents of an external data source.

You can create declarations in the following ways. Available config options are defined in
[DeclarationConfig](configs#sqlanvil-ActionConfig-DeclarationConfig), and are shared across all
the followiing ways of creating declarations.

**Using a SQLX file:**

```sql
-- definitions/name.sqlx
config {
  type: "declaration"
}
-- Note: no SQL should be present.
```

**Using action configs files:**

```yaml
# definitions/actions.yaml
actions:
- declare:
  name: name
```

**Using the Javascript API:**

```js
// definitions/file.js
declare("name")
```

## Hierarchy

* ActionBuilder‹Declaration›

  ↳ **Declaration**

## Index

### Methods

* [columns](_core_actions_declaration_.declaration.md#columns)
* [description](_core_actions_declaration_.declaration.md#description)

## Methods

###  columns

▸ **columns**(`columns`: ColumnDescriptor[]): *this*

**`deprecated`** Deprecated in favor of
[DeclarationConfig.columns](configs#sqlanvil-ActionConfig-DeclarationConfig).

Sets the column descriptors of columns in this table.

**Parameters:**

Name | Type |
------ | ------ |
`columns` | ColumnDescriptor[] |

**Returns:** *this*

___

###  description

▸ **description**(`description`: string): *this*

**`deprecated`** Deprecated in favor of
[DeclarationConfig.description](configs#sqlanvil-ActionConfig-DeclarationConfig).

Sets the description of this assertion.

**Parameters:**

Name | Type |
------ | ------ |
`description` | string |

**Returns:** *this*
