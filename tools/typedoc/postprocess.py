#!/usr/bin/env python3
"""Post-process a typedoc-plugin-markdown class page into a publishable reference page.

typedoc emits a multi-file site (classes/, interfaces/, modules/, README, globals) with
relative cross-links and a breadcrumb header. The published docs are a FLAT set of class
pages under reference/, so those raw links are broken. This script:

  1. Drops the leading breadcrumb line ("[... API Reference] > Globals > ...").
  2. Rewrites markdown links [text](target):
       - "configs" / "configs#x"            -> kept (the proto reference is published).
       - link to the CURRENT class page      -> "[text](#anchor)" (or plain text if no anchor).
       - link to ANOTHER published class page -> "[text](slug#anchor)".
       - anything else (modules/, interfaces/, README, globals, unpublished classes
         such as export/jit_context)          -> de-linked to plain "text".

Usage: postprocess.py <input.md> <current-slug>
Prints the cleaned markdown to stdout.
"""
import re
import sys

# typedoc class filename -> published reference slug.
PUBLISHED = {
    "_core_actions_assertion_.assertion.md": "assertion",
    "_core_actions_table_.table.md": "table",
    "_core_actions_view_.view.md": "view",
    "_core_actions_incremental_table_.incrementaltable.md": "incrementaltable",
    "_core_actions_operation_.operation.md": "operation",
    "_core_actions_notebook_.notebook.md": "notebook",
    "_core_actions_test_.test.md": "test",
    "_core_actions_declaration_.declaration.md": "declaration",
    "_core_session_.session.md": "session",
}

LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
BREADCRUMB = re.compile(r"^\[.*API Reference\].*›")


def rewrite_target(text, target, current_slug):
    # Keep links to the proto reference page.
    if target == "configs" or target.startswith("configs#"):
        return None  # signal: keep original link unchanged
    file_part, _, anchor = target.partition("#")
    anchor = ("#" + anchor) if anchor else ""
    slug = PUBLISHED.get(file_part)
    if slug is not None:
        if slug == current_slug:
            return f"[{text}](#{anchor[1:]})" if anchor else text
        return f"[{text}]({slug}{anchor})"
    # Unpublished target (modules/, interfaces/, README, globals, export, jit_context, ...).
    if file_part.startswith("../") or file_part.endswith(".md"):
        return text
    return None  # leave anything unrecognised untouched


def main():
    path, current_slug = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as fh:
        lines = fh.readlines()

    # Drop the breadcrumb line and a single following blank line.
    if lines and BREADCRUMB.match(lines[0]):
        lines = lines[1:]
        if lines and lines[0].strip() == "":
            lines = lines[1:]

    def repl(m):
        out = rewrite_target(m.group(1), m.group(2), current_slug)
        return m.group(0) if out is None else out

    sys.stdout.write(LINK.sub(repl, "".join(lines)))


if __name__ == "__main__":
    main()
