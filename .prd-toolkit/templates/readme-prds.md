<!-- prd-toolkit:start -->
# Product requirements

Each folder here is a living PRD: the requirements for one system in this repository, kept in
step with its code. Code implements its PRD; a change in behaviour starts in the PRD.

{{prds}}

## How it works

- Each area of a system has requirements (`FR-nnn`); each requirement has acceptance criteria
  (`AC-nnn.n`), and each criterion has test cases (`T-nnn.n`).
- Tests cite the test cases they prove, and commits cite the requirements they implement
  (`Refs: FR-012`), so a change can be traced from the PRD to the code and back.
- Bugs are recorded in each PRD's `errors.md` before they are fixed.
- Lint, the git hooks and CI check that the PRD, the tests and the code stay in step.

## Getting started

- Install the prd-toolkit plugin for Claude Code: {{homepage}}
- Once per clone: `.prd-toolkit/prd hooks install docs/prd/<slug>`
- Then see each PRD's README.
<!-- prd-toolkit:end -->
