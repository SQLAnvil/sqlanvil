-- Format: references/prd-format.md, "Contract YAML shapes" (schema.sql).
-- The artifact views that `sqlanvil query`, `inspect` and `docs` expose over the Parquet files
-- under <project-dir>/target/ (FR-010). Each is a DuckDB view over read_parquet, declared here as
-- a table so that its columns and types are a contract a linked PRD can cite. Column order and
-- types are the ones AC-001.2, AC-005.1 and AC-005.11 state; no value is null.

CREATE TABLE actions (
  target_key VARCHAR NOT NULL,
  "database" VARCHAR NOT NULL,
  "schema" VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  readable_name VARCHAR NOT NULL,
  type VARCHAR NOT NULL,
  tags VARCHAR NOT NULL,
  disabled BOOLEAN NOT NULL,
  file_name VARCHAR NOT NULL,
  description VARCHAR NOT NULL
);
COMMENT ON TABLE actions IS 'One row per action of the compiled graph, from target/catalog/actions.parquet (FR-001, FR-002)';
COMMENT ON COLUMN actions.target_key IS 'The action target as JSON with its keys sorted (AC-002.3)';
COMMENT ON COLUMN actions."database" IS 'The target database, or an empty string (AC-002.3, AC-002.5)';
COMMENT ON COLUMN actions."schema" IS 'The target schema (AC-002.3)';
COMMENT ON COLUMN actions.name IS 'The target name (AC-002.3)';
COMMENT ON COLUMN actions.readable_name IS 'database.schema.name, or schema.name when the target has no database (AC-002.3)';
COMMENT ON COLUMN actions.type IS 'table, view, incremental, operation, assertion, export, import, script or declaration (AC-002.2)';
COMMENT ON COLUMN actions.tags IS 'The JSON array text of the action tags, [] when none (AC-002.4, AC-002.5)';
COMMENT ON COLUMN actions.disabled IS 'Whether the action is disabled, false when unset (AC-002.4, AC-002.5)';
COMMENT ON COLUMN actions.file_name IS 'The action file name, or an empty string (AC-002.4, AC-002.5)';
COMMENT ON COLUMN actions.description IS 'The action descriptor description, or an empty string (AC-002.4, AC-002.5)';

CREATE TABLE dependencies (
  from_target_key VARCHAR NOT NULL,
  to_target_key VARCHAR NOT NULL,
  from_readable VARCHAR NOT NULL,
  to_readable VARCHAR NOT NULL
);
COMMENT ON TABLE dependencies IS 'One row per dependency edge, from target/catalog/dependencies.parquet (FR-003)';
COMMENT ON COLUMN dependencies.from_target_key IS 'The depending action target_key (AC-003.1)';
COMMENT ON COLUMN dependencies.to_target_key IS 'The dependency target_key (AC-003.1)';
COMMENT ON COLUMN dependencies.from_readable IS 'The depending action readable_name (AC-003.1)';
COMMENT ON COLUMN dependencies.to_readable IS 'The dependency readable_name (AC-003.1)';

CREATE TABLE "columns" (
  target_key VARCHAR NOT NULL,
  readable_name VARCHAR NOT NULL,
  column_name VARCHAR NOT NULL,
  description VARCHAR NOT NULL
);
COMMENT ON TABLE "columns" IS 'One row per documented column, from target/catalog/columns.parquet (FR-004)';
COMMENT ON COLUMN "columns".target_key IS 'The action target_key (AC-004.1)';
COMMENT ON COLUMN "columns".readable_name IS 'The action readable_name (AC-004.1)';
COMMENT ON COLUMN "columns".column_name IS 'The column path parts joined with a dot (AC-004.1)';
COMMENT ON COLUMN "columns".description IS 'The column description, or an empty string (AC-004.1)';

CREATE TABLE runs (
  run_id BIGINT NOT NULL,
  run_status VARCHAR NOT NULL,
  target_key VARCHAR NOT NULL,
  readable_name VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  start_millis BIGINT NOT NULL,
  end_millis BIGINT NOT NULL,
  duration_millis BIGINT NOT NULL,
  error_message VARCHAR NOT NULL
);
COMMENT ON TABLE runs IS 'One row per action result of every recorded run, from target/runs/*.parquet (FR-005, AC-010.2)';
COMMENT ON COLUMN runs.run_id IS 'The run id, epoch milliseconds by default (AC-005.1, AC-005.2)';
COMMENT ON COLUMN runs.run_status IS 'The run execution status name, UNKNOWN when absent (AC-005.3, AC-005.4)';
COMMENT ON COLUMN runs.target_key IS 'The action target_key (AC-005.1)';
COMMENT ON COLUMN runs.readable_name IS 'The action readable_name (AC-005.1)';
COMMENT ON COLUMN runs.status IS 'The action execution status name, UNKNOWN when absent (AC-005.3, AC-005.4)';
COMMENT ON COLUMN runs.start_millis IS 'The action start time in epoch milliseconds, 0 when absent (AC-005.5)';
COMMENT ON COLUMN runs.end_millis IS 'The action end time in epoch milliseconds, 0 when absent (AC-005.5)';
COMMENT ON COLUMN runs.duration_millis IS 'end_millis minus start_millis when both are non-zero, else 0 (AC-005.5)';
COMMENT ON COLUMN runs.error_message IS 'The first task error message, or an empty string (AC-005.6)';

CREATE TABLE run_summary (
  run_id BIGINT NOT NULL,
  run_status VARCHAR NOT NULL
);
COMMENT ON TABLE run_summary IS 'One row per recorded run, including runs with no action results, from target/run_summary/*.parquet (AC-005.11, AC-010.6)';
COMMENT ON COLUMN run_summary.run_id IS 'The run id (AC-005.11)';
COMMENT ON COLUMN run_summary.run_status IS 'The run execution status name, UNKNOWN when absent (AC-005.11)';
