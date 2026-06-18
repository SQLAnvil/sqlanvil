/**
 * Resolves the destination URI for an export action.
 *
 * `location` is a folder/prefix; the filename is derived (the export's `filename`, else the action
 * name) and the extension comes from the format. BigQuery requires a `*` wildcard in the URI, so
 * `opts.wildcard` injects `_*` before the extension; DuckDB writes a single concrete file.
 */
export function extensionForFormat(format: string): string {
  switch ((format || "").toLowerCase()) {
    case "parquet":
      return ".parquet";
    case "csv":
      return ".csv";
    case "json":
      return ".jsonl";
    default:
      return "";
  }
}

export function resolveExportUri(
  spec: { location?: string | null; format?: string | null; filename?: string | null },
  actionName: string,
  opts: { wildcard: boolean }
): string {
  const prefix = (spec.location || "").replace(/\/+$/, "");
  const base = spec.filename || actionName;
  const ext = extensionForFormat(spec.format || "");
  const name = opts.wildcard ? `${base}_*${ext}` : `${base}${ext}`;
  return `${prefix}/${name}`;
}
