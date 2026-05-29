# Upstream Merge & Sync Guide: dataform-co/dataform → sqlanvil

This guide outlines a highly robust, sandboxed process for pulling, merging, and resolving conflicts when syncing changes from Google's upstream `dataform-co/dataform` releases (such as `3.0.58`) into the **SQLAnvil** codebase.

---

## 1. Upstream Sync Process Architecture

To ensure your primary local `main` branch remains 100% stable during the merge, **always perform the merge inside a temporary sandbox branch** before merging back into `main`.

```
                   upstream/main (Google)
                         │
                         ├── (Tagged Release: e.g. 3.0.58)
                         ▼
             [1. Fetch tag over HTTPS]
                         │
                         ▼
            [2. Create sandbox branch]
           `upstream-sync/dataform-3.0.58`
                         │
                         ▼
          [3. Execute Merge & Resolve Conflicts]
          - Mechanical import renames (df/ → sa/)
          - Proto packages (dataform → sqlanvil)
                         │
                         ▼
              [4. Run Bazel Verification]
             `./scripts/docker-bazel test //...`
                         │
                         ▼
              [5. Merge back to main]
```

---

## 2. Step-by-Step Execution Guide

### Step 1: Fetch Upstream Releases
Ensure your `upstream` remote is configured using HTTPS (to unblock sandbox egress) and fetch all tags:
```bash
# 1. Update upstream URL to HTTPS
git remote set-url upstream https://github.com/dataform-co/dataform.git

# 2. Fetch latest releases & tags
git fetch upstream --tags
```

### Step 2: Create a Sandbox Sync Branch
Checkout a fresh sandbox branch from your local stable `main` branch:
```bash
git checkout main
git checkout -b upstream-sync/3.0.58
```

### Step 3: Run the Merge
Attempt to merge the targeted release tag (e.g. `3.0.58`) into the sandbox:
```bash
git merge 3.0.58
```

---

## 3. Anticipated Conflicts & Resolution Playbook

Since the Dataform $\rightarrow$ SQLAnvil rename touches namespaces and import paths, the merge will trigger a small number of predictable conflicts. Use this playbook to resolve them:

### A. Conflict Type: Protobuf Packages (`protos/core.proto`)
**Conflict:** Upstream adds new protobuf fields inside `package dataform;` whereas SQLAnvil uses `package sqlanvil;`.
* **Resolution:**
  - Keep SQLAnvil's package declaration: `package sqlanvil;`.
  - Copy the new fields added by Google (e.g., `string jit_code = ...` inside `Assertion` message) and insert them using SQLAnvil naming conventions.

### B. Conflict Type: TypeScript Imports (`df/` vs `sa/`)
**Conflict:** Upstream imports use `df/`, e.g.:
```typescript
import { ActionBuilder } from "df/core/actions";
```
SQLAnvil uses `sa/`:
```typescript
import { ActionBuilder } from "sa/core/actions/base";
```
* **Resolution:**
  - Standardize all new/merged imports to use the `sa/` prefix.

### C. Conflict Type: Code References (`dataform.` vs `sqlanvil.`)
**Conflict:** Upstream TypeScript code references Google's generated proto namespace `dataform.Assertion`, while SQLAnvil uses `sqlanvil.Assertion`.
* **Resolution:**
  - Globally replace the merged references to use `sqlanvil.` instead of `dataform.`.

---

## 4. Verification & Clean-Up

Once all conflicts are resolved, run the full validation suite inside your development container:

```bash
# 1. Run core compiler tests
./scripts/docker-bazel test //core/...

# 2. Run the newly updated integration tests
PG_HOST=host.docker.internal PG_PORT=5432 ./scripts/docker-bazel test //tests/integration:postgres.spec --test_env=PG_HOST --test_env=PG_PORT --test_env=PG_USER --test_env=PG_PASSWORD --test_env=PG_DATABASE
```

If the build completes and all tests pass:
```bash
# 3. Checkout main & merge the verified sync branch
git checkout main
git merge upstream-sync/3.0.58

# 4. Clean up the sandbox branch
git branch -d upstream-sync/3.0.58

# 5. Push updated main to your GitHub stealth repository
git push origin main
```
