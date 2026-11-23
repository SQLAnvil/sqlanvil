<!-- prd-toolkit:start -->
# {{slug}} — product requirements

This folder is the living PRD for **{{slug}}**: the requirements that say what it does, kept in
step with the code. The code implements this PRD, and a change in behaviour starts here, not in
the code. It is maintained with prd-toolkit, a Claude Code plugin{{parent_link}}.

Version {{version}} · {{status}} · Owner: {{owner}} · Updated {{updated}}

## What this PRD covers

{{summary}}

## Areas

{{areas}}

## What is in this folder

{{files}}
{{links}}
## Reading and changing it

- Read `prd.md`, then the area you care about. With the plugin: `/prd-toolkit:prd-status` for
  where every requirement stands, `/prd-toolkit:prd-context <area>` for one area,
  `/prd-toolkit:prd-publish` for a readable page.
- Don't edit these files by hand. A change in behaviour starts with `/prd-toolkit:prd-change` and
  is built with `/prd-toolkit:prd-build`; a bug starts with `/prd-toolkit:prd-error`. Lint and the
  git hooks check every commit.
<!-- prd-toolkit:end -->
