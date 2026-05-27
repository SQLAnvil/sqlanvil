import { IDbAdapter } from "sa/cli/api/dbadapters";
import { sqlanvil } from "sa/protos/ts";

export async function state(
  dbadapter: IDbAdapter,
  targets: sqlanvil.ITarget[]
): Promise<sqlanvil.IWarehouseState> {
  const allTables = await Promise.all(targets.map(async target => dbadapter.table(target)));

  // Filter out datasets that don't exist.
  const tablesWithValues = allTables.filter(table => {
    return !!table && !!table.type;
  });
  return { tables: tablesWithValues };
}
