/**
 * ESLint flat config for the SQLAnvil CLI & Core repo.
 *
 * Scope: currently only used to enforce sandbox-safety rules in `core/`.
 * The rest of the codebase is still linted by tslint (see tslint.json).
 * Add ESLint rules here only when they need capabilities tslint 5.17 cannot
 * express (per-file scoping, per-message text, AST rules, etc.).
 */
const rawTsParser = require('@typescript-eslint/parser');
const noNodeBuiltins = require('./eslint-rules/no-node-builtins');

// @typescript-eslint/parser v5 predates ESLint 10, which calls scopeManager.addGlobals().
// Same shim as upstream's eslint.config.js.
const tsParser = {
  ...rawTsParser,
  parseForESLint(code, options) {
    const result = rawTsParser.parseForESLint(code, options);
    if (result.scopeManager && !result.scopeManager.addGlobals) {
      result.scopeManager.addGlobals = (names) => {
        for (const name of names) {
          if (!result.scopeManager.globalScope.set.has(name)) {
            result.scopeManager.globalScope.defineImplicitVariable(name, {
              isTypeVariable: false,
              isValueVariable: true,
            });
          }
        }
      };
    }
    return result;
  },
};

module.exports = [
  {
    ignores: ['node_modules/**', 'bazel-*/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: 'module',
    },
    plugins: {
      local: {
        rules: {
          'no-node-builtins': noNodeBuiltins,
        },
      },
    },
  },
  {
    // core/ runs inside the V8 compilation sandbox — no Node built-ins.
    files: ['core/**/*.ts'],
    rules: {
      'local/no-node-builtins': 'error',
    },
  },
  {
    // Tests under core/ run on the host Node runtime, not in the sandbox,
    // so they may legitimately use fs, path, etc. for fixture setup.
    files: ['core/**/*_test.ts', 'core/**/*.test.ts'],
    rules: {
      'local/no-node-builtins': 'off',
    },
  },
];
