"""Stage OpenAddresses address points for the `openaddresses_us` import action.

This is a `python:` script action (declared in definitions/actions.yaml) — the in-DAG home
for ingestion glue that would otherwise live in a VM crontab beside the pipeline. One
`sqlanvil run` executes: this script -> the file import -> staging -> marts -> assertions.

The contract for script actions is deliberately narrow: the script STAGES A FILE (no warehouse
credentials are ever injected); the downstream `type: "import"` action is the loading boundary.

Behavior:
  - With an `oa_source_url` var set (workflow_settings.yaml `vars:` or --vars), downloads a
    region CSV from openaddresses.io and stages it.
  - Without one (the out-of-the-box example), stages the bundled 12-row sample.
  - Either way, rows with unparseable/out-of-range coordinates are dropped here, at the edge —
    the same rule assert_address_coordinates_valid enforces inside the warehouse.

Environment: stdlib only (csv/json/os/urllib), python >= 3.9 (see actions.yaml).
"""

import csv
import json
import os
import sys
import urllib.request

OUT_PATH = os.path.join("data", "openaddresses_us.csv")
SAMPLE_PATH = os.path.join("data", "openaddresses_sample.csv")
COLUMNS = ["lon", "lat", "number", "street", "unit", "city", "district", "region", "postcode", "id", "hash"]


def coordinates_ok(row):
    try:
        lon, lat = float(row["lon"]), float(row["lat"])
    except (KeyError, TypeError, ValueError):
        return False
    return -180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0


def main():
    vars_json = json.loads(os.environ.get("SA_VARS", "{}"))
    source_url = vars_json.get("oa_source_url", "")

    if source_url:
        print(f"downloading {source_url} ...")
        with urllib.request.urlopen(source_url) as response:
            raw = response.read().decode("utf-8")
        reader = csv.DictReader(raw.splitlines())
    else:
        print(f"no oa_source_url var set - staging the bundled sample ({SAMPLE_PATH})")
        reader = csv.DictReader(open(SAMPLE_PATH, newline=""))

    total = kept = 0
    os.makedirs("data", exist_ok=True)
    with open(OUT_PATH, "w", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in reader:
            total += 1
            if coordinates_ok(row):
                writer.writerow(row)
                kept += 1

    dropped = total - kept
    print(f"staged {kept} address points to {OUT_PATH} ({dropped} dropped for bad coordinates)")
    if kept == 0:
        print("no valid rows staged - failing so the import doesn't load an empty file", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
