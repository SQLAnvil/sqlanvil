#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "sqlglot>=25", "openapi-spec-validator>=0.7"]
# ///
"""Vendor the toolkit into a repo and manage its git hooks: install | check | uninstall | vendor <prd-folder> (vendor refreshes .prd-toolkit/ alone, from the plugin); ci --gitlab|--github [--force] <prd-folder> writes the merge-gate CI include file. Exit 0 clean, 1 findings, 2 usage, dependency or internal error."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdlint import deps  # noqa: E402

for _module, _package in (("yaml", "pyyaml"), ("sqlglot", "sqlglot"), ("openapi_spec_validator", "openapi-spec-validator")):
    deps.require(_module, _package)

from prdlint import hooks, model  # noqa: E402


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="prd_hooks.py", description="Vendor the PRD toolkit and install its git hooks.")
    parser.add_argument("action", choices=("install", "check", "uninstall", "ci", "vendor"))
    parser.add_argument("prd_dir")
    parser.add_argument("--gitlab", action="store_true")
    parser.add_argument("--github", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--ci", action="store_true", help="check: compare only the generated CI files (works from the vendored copy)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:
        return 0 if e.code in (0, None) else 2
    if args.action == "ci":
        if args.gitlab == args.github:
            print("prd_hooks: ci needs exactly one of --gitlab or --github", file=sys.stderr)
            return 2
    elif args.gitlab or args.github or args.force:
        print("prd_hooks: --gitlab, --github and --force belong to ci", file=sys.stderr)
        return 2
    if args.ci and args.action != "check":
        print("prd_hooks: --ci belongs to check", file=sys.stderr)
        return 2
    try:
        prd = model.load(Path(args.prd_dir))
    except model.NotAPrd as e:
        print(f"prd_hooks: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_hooks: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    if args.action == "check" and args.ci and model.git_toplevel(prd.root) is None:
        print(f"prd_hooks: {hooks.not_a_checkout(prd)}", file=sys.stderr)
        return 2
    try:
        root = model.repo_root(prd.root).resolve()
        if args.action == "check" and not args.ci and not hooks.is_plugin():
            print("prd_hooks: run check from the plugin, not the vendored copy", file=sys.stderr)
            return 2
        if args.action == "ci":
            try:
                prd_rel = prd.root.resolve().relative_to(root).as_posix()
            except ValueError:
                print(f"prd_hooks: {prd.root} is not inside the repository at {root}", file=sys.stderr)
                return 2
            if (root / hooks.VENDOR_DIR).is_dir() and not (root / hooks.VENDOR_DIR / hooks.LAUNCHER).is_file():
                # the workflow runs `sh .prd-toolkit/prd`: written over a copy without it, every CI job would fail
                print(f"prd_hooks: {hooks.VENDOR_DIR}/ predates 0.8.8 (no {hooks.VENDOR_DIR}/{hooks.LAUNCHER}); run prd_hooks.py install {args.prd_dir} first", file=sys.stderr)
                return 2
            code, out = hooks.write_ci(root, "gitlab" if args.gitlab else "github", hooks.ci_jobs(prd, prd_rel) + hooks.deploy_jobs(prd, prd_rel), args.force, prd.operations.secrets)
            for line in out:
                print(line)
            return code
        if args.action == "vendor" and not hooks.is_plugin():
            print("prd_hooks: vendor runs from the plugin, not from .prd-toolkit/", file=sys.stderr)
            return 2
        if args.action in ("install", "vendor"):
            try:
                prd_rel = prd.root.resolve().relative_to(root).as_posix()
            except ValueError:
                print(f"prd_hooks: {prd.root} is not inside the repository at {root}", file=sys.stderr)
                return 2
            out = (hooks.vendor if args.action == "vendor" else hooks.install)(root, prd_rel)
        elif args.action == "check":
            try:
                prd_rel = prd.root.resolve().relative_to(root).as_posix()
            except ValueError:
                print(f"prd_hooks: {prd.root} is not inside the repository at {root}", file=sys.stderr)
                return 2
            out = hooks.stale_ci(root, prd, prd_rel) if args.ci else hooks.check(root, hooks.PLUGIN_ROOT, prd, prd_rel)
        else:
            out = hooks.uninstall(root)
    except hooks.BlocksRefused as e:
        print(f"prd_hooks: install refused: {e}", file=sys.stderr)
        return 1
    except hooks.InstallRefused as e:
        print(f"prd_hooks: install refused: {e}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"prd_hooks: internal error: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    for line in out:
        print(line)
    return 1 if args.action == "check" and out else 0


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))
