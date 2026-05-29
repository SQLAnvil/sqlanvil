# Class: Assertion

An assertion is a data quality test query that finds rows that violate one or more conditions
specified in the query. If the query returns any rows, the assertion fails.

You can create assertions in the following ways. Available config options are defined in
[AssertionConfig](configs#sqlanvil-ActionConfig-AssertionConfig), and are shared across all the
following ways of creating assertions.

**Using a SQLX file:**

```sql
-- definitions/name.sqlx
config {
  type: "assertion"
}
SELECT * FROM table WHERE a IS NULL
```

**Using built-in assertions in the config block of a table:**

See [TableConfig.assertions](configs#sqlanvil-ActionConfig-TableConfig)

**Using action configs files:**

```yaml
# definitions/actions.yaml
actions:
- assertion:
  filename: name.sql
```

```sql
-- definitions/name.sql
SELECT * FROM table WHERE a IS NULL
```

**Using the Javascript API:**

```js
// definitions/file.js
assert("name").query("SELECT * FROM table WHERE a IS NULL")
```

Note: When using the Javascript API, methods in this class can be accessed by the returned value.
This is where `query` comes from.

## Hierarchy

* ActionBuilder‹Assertion›

  ↳ **Assertion**

## Index

### Methods

* [database](#database)
* [dependencies](#dependencies)
* [description](#description)
* [disabled](#disabled)
* [hermetic](#hermetic)
* [query](#query)
* [schema](#schema)
* [tags](#tags)

## Methods

###  database

▸ **database**(`database`: string): *this*

**`deprecated`** Deprecated in favor of
[AssertionConfig.project](configs#sqlanvil-ActionConfig-AssertionConfig).

Sets the database in which to create the corresponding view for this assertion.
For BigQuery targets this is the Google Cloud project ID; for Postgres/Supabase targets this
is the database name configured in `workflow_settings.yaml`.

**Parameters:**

Name | Type |
------ | ------ |
`database` | string |

**Returns:** *this*

___

###  dependencies

▸ **dependencies**(`value`: Resolvable | Resolvable[]): *this*

**`deprecated`** Deprecated in favor of
[AssertionConfig.dependencies](configs#sqlanvil-ActionConfig-AssertionConfig).

Sets dependencies of the assertion.

**Parameters:**

Name | Type |
------ | ------ |
`value` | Resolvable &#124; Resolvable[] |

**Returns:** *this*

___

###  description

▸ **description**(`description`: string): *this*

**`deprecated`** Deprecated in favor of
[AssertionConfig.description](configs#sqlanvil-ActionConfig-AssertionConfig).

Sets the description of this assertion.

**Parameters:**

Name | Type |
------ | ------ |
`description` | string |

**Returns:** *this*

___

###  disabled

▸ **disabled**(`disabled`: boolean): *this*

**`deprecated`** Deprecated in favor of
[AssertionConfig.disabled](configs#sqlanvil-ActionConfig-AssertionConfig).

If called with `true`, this action is not executed. The action can still be depended upon.
Useful for temporarily turning off broken actions.

**Parameters:**

Name | Type | Default |
------ | ------ | ------ |
`disabled` | boolean | true |

**Returns:** *this*

___

###  hermetic

▸ **hermetic**(`hermetic`: boolean): *void*

**`deprecated`** Deprecated in favor of
[AssertionConfig.hermetic](configs#sqlanvil-ActionConfig-AssertionConfig).

If true, this indicates that the action only depends on data from explicitly-declared
dependencies. Otherwise if false, it indicates that the action depends on data from a source
which has not been declared as a dependency.

**Parameters:**

Name | Type |
------ | ------ |
`hermetic` | boolean |

**Returns:** *void*

___

###  query

▸ **query**(`query`: AContextable‹string›): *this*

Sets the query to be run by the assertion.

**Parameters:**

Name | Type |
------ | ------ |
`query` | AContextable‹string› |

**Returns:** *this*

___

###  schema

▸ **schema**(`schema`: string): *this*

**`deprecated`** Deprecated in favor of
[AssertionConfig.dataset](configs#sqlanvil-ActionConfig-AssertionConfig).

Sets the schema in which to create the corresponding view for this assertion.
For BigQuery targets this is the dataset name; for Postgres/Supabase targets this is the
schema name (e.g. `public`).

**Parameters:**

Name | Type |
------ | ------ |
`schema` | string |

**Returns:** *this*

___

###  tags

▸ **tags**(`value`: string | string[]): *this*

**`deprecated`** Deprecated in favor of
[AssertionConfig.tags](configs#sqlanvil-ActionConfig-AssertionConfig).

Sets a list of user-defined tags applied to this action.

**Parameters:**

Name | Type |
------ | ------ |
`value` | string &#124; string[] |

**Returns:** *this*
