import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import * as path from "path";

function convertToRegex(pattern) {
  if (pattern instanceof RegExp) {
    return pattern;
  }
  // If it's a string, turn it into a regex, by escaping any regex characters in the string.
  const normalized = pattern.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`^${normalized}$`);
}

// Add new node built ins here if they are used.
const knownNodeBuiltins = [
  "path",
  "fs",
  "os",
  "util",
  "child_process",
  "crypto",
  "events",
  "long",
  "https",
  "net",
  "module",
  "vm",
].map((moduleName) => convertToRegex(moduleName));

const importsToBundle = ["sa", /^sa\/.*$/];

const checkImports = (imports) => {
  const allowedImports = [...imports].map((pattern) => convertToRegex(pattern));
  // We're going to read these from the arguments.
  let externals = () => false;
  let allowNodeBuiltins = process.env.ALLOW_NODE_BUILTINS;

  return {
    buildStart(options) {
      externals = options.external || (() => false);
    },
    resolveId(source, importer, options) {
      if (!importer || path.isAbsolute(source) || source.startsWith(".")) {
        return null;
      }
      if (source.startsWith("sa/")) {
        // Forward `options` so that @rollup/plugin-commonjs's metadata (e.g. whether this is a
        // require() call) reaches node-resolve.
        return this.resolve(path.resolve(source.slice(3)), importer, {
          ...options,
          skipSelf: true,
        });
      }
      if (allowedImports.some((pattern) => pattern.test(source))) {
        return null;
      }
      if (
        externals(source) ||
        externals(source.split("/")[0]) ||
        (allowNodeBuiltins && knownNodeBuiltins.some((pattern) => pattern.test(source)))
      ) {
        return false;
      }
      throw new Error("Must explicitly list import as an external: " + source);
    },
  };
};

export default {
  output: {
    exports: "auto",
  },
  plugins: [
    checkImports(importsToBundle),
    nodeResolve(),
    commonjs({
      strictRequires: true,
      // Leave these require() calls untouched, so they resolve at runtime. cli/vm/jit_worker.ts
      // requires the project's (or a JiT-installed) @sqlanvil/core, which isn't a CLI dependency,
      // so it must not be listed in `externals` (that would add it to the package.json).
      ignore: ["@sqlanvil/core"],
      // nativeRequire() (core/utils.ts) loads optional runtime dependencies such as
      // @duckdb/node-api through a non-literal require. Rollup must leave those alone instead of
      // replacing them with a "Could not dynamically require" stub.
      ignoreDynamicRequires: true,
    }),
  ],
};
