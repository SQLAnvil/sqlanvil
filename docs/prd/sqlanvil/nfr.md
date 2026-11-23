<!-- Format: references/prd-format.md, "Requirement blocks". -->

# Non-functional requirements

No non-functional requirement is adopted yet. Each one comes with the area it bounds (for example compile time with the compiler area, run concurrency with the execution area), with a measurable bound, a unit and a test (owner, 2026-11-22).

## Observability

The CLI writes results to stdout and errors and warnings to stderr; with `--json`, the machine-readable output goes to stdout. No connection password, token or key from `.df-credentials.json` ever appears on either. sqlanvil sends no telemetry (owner, 2026-11-22).

| Metric | Error code | Alert threshold |
|---|---|---|
| Not applicable: sqlanvil sends no telemetry | - | - |
