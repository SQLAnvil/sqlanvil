<!-- Format: references/prd-format.md, "Contract YAML shapes" (dependencies row). -->

# Dependencies

One `<service>.yaml` per external service. Each file holds `sends`, `expects`, `auth` (`secret`: the
secret's name, never its value), `limits`, `mock` (how tests stand in for it) and `failures` with
`timeout`, `4xx`, `5xx` and `outage`, each an error code from `contracts/errors.yaml`.
