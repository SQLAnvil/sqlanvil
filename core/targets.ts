import { JSONObjectStringifier } from "sa/common/strings/stringifier";
import { sqlanvil } from "sa/protos/ts";

/** Produces an unambigous mapping to and from a string representation. */
export const targetStringifier = new JSONObjectStringifier<sqlanvil.ITarget>();

/**
 * Provides a readable string representation of the target which is used for e.g. specifying
 * actions on the CLI.
 * This is effectively equivelant to an action "name".
 *
 * This is an ambiguous transformation, multiple targets may map to the same string
 * and it should not be used for indexing. Use @see {@link targetStringifier} instead.
 */
export function targetAsReadableString(target: sqlanvil.ITarget): string {
  const nameParts = [target.name, target.schema];
  if (!!target.database) {
    nameParts.push(target.database);
  }
  return nameParts.reverse().join(".");
}

/**
 * Whether a target's project (database) misuses ':'. BigQuery project IDs can be domain-scoped
 * (`<domain>:<project>`, e.g. `example.com:my-project`); anything else with a colon (a leading or
 * trailing one, or more than one) is rejected (upstream #2471).
 */
export function hasInvalidProjectColonUsage(database: string): boolean {
  const colonIndex = database.indexOf(":");
  return (
    colonIndex !== -1 &&
    (colonIndex === 0 ||
      colonIndex === database.length - 1 ||
      database.includes(":", colonIndex + 1))
  );
}

/** Returns the project part of a domain-scoped `<domain>:<project>` project ID. */
export function stripProjectDomainPrefix(database: string): string {
  const colonIndex = database.indexOf(":");
  return colonIndex > 0 ? database.slice(colonIndex + 1) : database;
}
