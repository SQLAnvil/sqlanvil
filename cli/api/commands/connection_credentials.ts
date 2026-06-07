import { sqlanvil } from "sa/protos/ts";

// Matches the non-secret placeholders emitted by the FDW bridge for postgres/supabase
// source connections, e.g. `${SA_CONN:my_source:user}` / `${SA_CONN:my_source:password}`.
// The compiled graph only ever contains these tokens; the real credentials are
// substituted from `.df-credentials.json`'s `connections` map at execution time.
const CONNECTION_TOKEN = /\$\{SA_CONN:([^:}]+):([^}]+)\}/g;

/**
 * Replaces `${SA_CONN:<conn>:<field>}` placeholders in a single SQL statement with the
 * matching value from the `connections` credentials map. Throws a clear error if the
 * referenced connection or field is missing. Single quotes in values are escaped so the
 * result is safe inside a `'...'` SQL string literal.
 */
export function substituteConnectionCredentials(
  statement: string,
  connections: { [name: string]: any }
): string {
  return statement.replace(CONNECTION_TOKEN, (_match, connectionName, field) => {
    const entry = connections[connectionName];
    if (!entry) {
      throw new Error(
        `Connection "${connectionName}" is referenced by an FDW bridge but has no entry under ` +
          `"connections" in .df-credentials.json. Add connections.${connectionName} with the ` +
          `source user/password.`
      );
    }
    const value = entry[field];
    if (value === undefined || value === null || value === "") {
      throw new Error(
        `Connection "${connectionName}" is missing "${field}" under "connections.${connectionName}" ` +
          `in .df-credentials.json.`
      );
    }
    return String(value).replace(/'/g, "''");
  });
}

/**
 * Fail-fast validation: walks every task statement in the execution graph and confirms
 * all `${SA_CONN:...}` references resolve against the supplied credentials, before any
 * statement runs. Throws on the first unresolved reference.
 */
export function assertConnectionCredentialsAvailable(
  graph: sqlanvil.IExecutionGraph,
  connections: { [name: string]: any }
): void {
  (graph.actions || []).forEach(action =>
    (action.tasks || []).forEach(task => {
      if (task.statement) {
        substituteConnectionCredentials(task.statement, connections);
      }
    })
  );
}
