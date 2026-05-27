# GCP Test Project Setup for BigQuery Integration Tests

**Status:** Reference / runbook
**Audience:** sqlanvil contributors who need to run the BigQuery
integration tests (`//cli:index_run_e2e_test`,
`//tests/integration:bigquery.spec`) against a real BigQuery instance.

## 0. TL;DR

```bash
# One-time setup (~30 minutes):
export PROJECT_ID="sqlanvil-test-$(openssl rand -hex 3)"

gcloud projects create "$PROJECT_ID" --name="sqlanvil test"
gcloud config set project "$PROJECT_ID"
gcloud services enable bigquery.googleapis.com storage.googleapis.com

gcloud iam service-accounts create sqlanvil-test-runner \
  --display-name="sqlanvil integration test runner"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:sqlanvil-test-runner@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role=roles/bigquery.dataEditor

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:sqlanvil-test-runner@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role=roles/bigquery.jobUser

mkdir -p test_credentials
gcloud iam service-accounts keys create test_credentials/bigquery.json \
  --iam-account="sqlanvil-test-runner@${PROJECT_ID}.iam.gserviceaccount.com"

# Per-shell or sourced from .envrc:
export SQLANVIL_TEST_BQ_PROJECT="$PROJECT_ID"
export SQLANVIL_TEST_BQ_LOCATION="US"

# Verify:
./scripts/docker-bazel test //tests/integration:bigquery.spec
```

## 1. Why a dedicated project

- **Blast radius.** Bugs in test code could drop datasets. Keep that
  blast radius off any project that holds real data.
- **Billing isolation.** Easier to detect runaway test costs when the
  project has zero other workload.
- **Service-account scoping.** Least-privilege roles only — no admin
  access leaks if a key is ever exposed.
- **Cleanup.** Tearing down a project deletes everything; no orphans.

## 2. Cost expectations

BigQuery free tier covers all test usage comfortably:

| Resource | Free tier | Test usage |
| :--- | :--- | :--- |
| Storage | 10 GB/month | <10 MB |
| Query scans | 1 TB/month | <100 MB per test run |
| Streaming inserts | Not free | Tests don't use streaming |

**Expected monthly bill: $0** for normal contributor cadence (a few
hundred test runs/month).

Set a billing budget alert at $5/mo as a safety net (see §5).

## 3. Setup walkthrough

### 3.1. Prereqs

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- Either a personal Google account OR a billing account that allows
  free-tier-only projects
- Optional but recommended: `direnv` for per-repo env var loading

### 3.2. Create the project

Pick a unique project ID. GCP project IDs are globally unique and
permanent — use a random suffix:

```bash
PROJECT_ID="sqlanvil-test-$(openssl rand -hex 3)"
echo "$PROJECT_ID"  # e.g. sqlanvil-test-a3f7c9
```

```bash
gcloud projects create "$PROJECT_ID" --name="sqlanvil test"
gcloud config set project "$PROJECT_ID"
```

### 3.3. Link billing (required even for free-tier-only usage)

GCP requires a billing account on any project that uses APIs, even if
all usage stays in the free tier. List your billing accounts:

```bash
gcloud billing accounts list
```

Link one:

```bash
gcloud billing projects link "$PROJECT_ID" \
  --billing-account=BILLING_ACCOUNT_ID
```

### 3.4. Enable APIs

```bash
gcloud services enable \
  bigquery.googleapis.com \
  storage.googleapis.com
```

Storage is needed because some integration tests stage files in GCS.

### 3.5. Create the service account

```bash
gcloud iam service-accounts create sqlanvil-test-runner \
  --display-name="sqlanvil integration test runner"
```

### 3.6. Grant minimum roles

**Do NOT use roles/owner or roles/editor.** Stick to least privilege:

```bash
SA="sqlanvil-test-runner@${PROJECT_ID}.iam.gserviceaccount.com"

# Read/write BQ tables in this project
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/bigquery.dataEditor

# Run BQ jobs (queries, loads) in this project
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/bigquery.jobUser
```

If integration tests touch GCS (some notebook tests do):

```bash
# Read/write only — no bucket admin
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/storage.objectUser
```

### 3.7. Download the service-account key

```bash
mkdir -p test_credentials
gcloud iam service-accounts keys create test_credentials/bigquery.json \
  --iam-account="$SA"
```

**Verify:**

```bash
test -f test_credentials/bigquery.json && echo "OK" || echo "MISSING"
```

`test_credentials/*.json` is in `.gitignore` — confirm:

```bash
git status --porcelain test_credentials/bigquery.json | head
# (no output = ignored, good)
```

### 3.8. Set local env vars

`cli/index_test_base.ts` reads from these:

```bash
export SQLANVIL_TEST_BQ_PROJECT="$PROJECT_ID"
export SQLANVIL_TEST_BQ_LOCATION="US"
# Optional — only if you have a BQ reservation. Leave unset for on-demand:
# export SQLANVIL_TEST_BQ_RESERVATION="projects/$PROJECT_ID/locations/us/reservations/test"
```

Persist these — add to your shell profile or use a tool like `direnv`:

```bash
# .envrc (used by direnv)
export SQLANVIL_TEST_BQ_PROJECT="sqlanvil-test-a3f7c9"
export SQLANVIL_TEST_BQ_LOCATION="US"
```

### 3.9. Verify

```bash
./scripts/docker-bazel test //tests/integration:bigquery.spec
```

Expected: `PASSED`. If it still fails, see §6.

## 4. CI integration (GitHub Actions)

### 4.1. Store the key as a secret

GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret name | Value |
| :--- | :--- |
| `SQLANVIL_TEST_BQ_KEY` | Contents of `test_credentials/bigquery.json` (the full JSON, multi-line) |
| `SQLANVIL_TEST_BQ_PROJECT` | The project ID (e.g. `sqlanvil-test-a3f7c9`) |
| `SQLANVIL_TEST_BQ_LOCATION` | `US` (or your region) |

### 4.2. Workflow snippet

```yaml
# .github/workflows/test.yml
name: test

on: [push, pull_request]

jobs:
  bq-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Write BQ creds
        run: |
          mkdir -p test_credentials
          echo '${{ secrets.SQLANVIL_TEST_BQ_KEY }}' > test_credentials/bigquery.json

      - name: Test
        env:
          SQLANVIL_TEST_BQ_PROJECT: ${{ secrets.SQLANVIL_TEST_BQ_PROJECT }}
          SQLANVIL_TEST_BQ_LOCATION: ${{ secrets.SQLANVIL_TEST_BQ_LOCATION }}
        run: ./scripts/docker-bazel test //tests/integration:bigquery.spec
```

### 4.3. Forks

PRs from forks **don't** receive secrets by default. This is correct —
you don't want an attacker submitting a PR that exfiltrates your BQ
key. Either:

- Skip BQ integration tests on fork PRs (mark them `continue-on-error: true`)
- Run BQ tests only on `pull_request_target` events from trusted contributors
- Run BQ tests post-merge against `main` only

Recommend: skip on fork PRs, run on merge to main.

## 5. Hardening

### 5.1. Billing budget alert

```bash
# Replace with your billing account ID
gcloud billing budgets create \
  --billing-account=BILLING_ACCOUNT_ID \
  --display-name="sqlanvil-test budget" \
  --budget-amount=5 \
  --threshold-rule=percent=50 \
  --threshold-rule=percent=100 \
  --filter-projects="projects/${PROJECT_ID}"
```

Get email alerts at $2.50 (50%) and $5 (100%).

### 5.2. Daily BQ quota cap

In the GCP console: **IAM & Admin → Quotas → Filter "BigQuery API" →
Query usage per day per project →** set to `100 GiB`.

Hard limit. Worst-case impact is hours-of-lost-testing rather than
weeks-of-billing.

### 5.3. Key rotation

Service-account keys never expire by default. Rotate annually:

```bash
# List existing keys
gcloud iam service-accounts keys list \
  --iam-account="$SA"

# Create new key
gcloud iam service-accounts keys create test_credentials/bigquery.json \
  --iam-account="$SA"

# Delete old keys (record the KEY_ID from `list` above)
gcloud iam service-accounts keys delete OLD_KEY_ID \
  --iam-account="$SA"
```

Update the GitHub secret with the new key.

### 5.4. Test isolation

Tests should generate unique dataset names so parallel runs don't
collide. Pattern (already used in some tests):

```typescript
const DATASET = `sqlanvil_test_${process.env.BUILD_ID || Date.now()}`;
```

Tear down at end:

```typescript
afterAll(async () => {
  await client.dataset(DATASET).delete({ force: true });
});
```

## 6. Troubleshooting

### `Missing credentials JSON file; not found at path 'test_credentials/bigquery.json'`

The key file isn't where the tests look. Check:

```bash
ls -la test_credentials/bigquery.json
```

Bazel runs in a sandbox — the file needs to be declared as test data.
That declaration is in `cli/BUILD`:

```bazel
data = [
    "//test_credentials:bigquery.json",
    ...
]
```

If `test_credentials/BUILD` doesn't exist, create it:

```bash
cat > test_credentials/BUILD <<'EOF'
package(default_visibility = ["//visibility:public"])
exports_files(["bigquery.json"])
EOF
```

### `Permission denied` on a BQ operation

Service account is missing a role. Check current bindings:

```bash
gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten="bindings[].members" \
  --filter="bindings.members:${SA}"
```

Expected: `roles/bigquery.dataEditor`, `roles/bigquery.jobUser` (and
`roles/storage.objectUser` if storage tests touched).

### `BigQuery: Not found: Dataset xxx`

Tests need to create datasets they reference. If a test asserts against
a pre-existing dataset, you need to seed it once:

```bash
bq mk --dataset --location=US "$PROJECT_ID:sqlanvil_test"
```

### Builds in CI succeed but local fails

Likely env var difference. Compare:

```bash
env | grep SQLANVIL_
```

vs the GitHub Actions env. Common cause: `SQLANVIL_TEST_BQ_LOCATION`
unset locally, defaulting to "US" while CI sets it to a region your
project doesn't have datasets in.

## 7. Tear-down

When you no longer need the project:

```bash
gcloud projects delete "$PROJECT_ID"
```

This schedules the project for deletion (30-day grace period). All
billing stops immediately, but you can restore within 30 days:

```bash
gcloud projects undelete "$PROJECT_ID"
```

After 30 days, the project ID becomes unrecoverable (and reusable by
anyone — including squatters).

## 8. What this fixes

| Failing test (before setup) | After setup |
| :--- | :--- |
| `//cli:index_run_e2e_test` | ✅ passes |
| `//tests/integration:bigquery.spec` | ✅ passes |
| `//tests/api:projects.spec` | ❌ still fails — unrelated pre-existing bug (schema mismatch on `warehouse` property); see follow-up PR |

## 9. References

- `cli/index_test_base.ts` — where the constants are read
- `.gitignore` — keeps `test_credentials/*.json` out of commits
- `docs/postgres_first_class_design.md` §6 Phase 6 — Postgres integration
  test plan (parallel docker-driven fixture, no GCP)
- [BigQuery free tier](https://cloud.google.com/bigquery/pricing#free-tier)
- [Service-account key best practices](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)
