/**
 * Shared ESLint config for the Node workspaces (apps/api, packages/shared).
 * Errors are reserved for correctness/security rules (Phase 3 audit); style
 * rules are left off so the gate stays meaningful. Strict-mode measurement is
 * documented in docs/qa/PHASE-03.md.
 */
module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "regexp"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "plugin:regexp/recommended"],
  env: { node: true, es2022: true },
  rules: {
    // --- correctness / security: errors ---
    "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
    "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-base-to-string": "error",
    "regexp/no-super-linear-backtracking": "error",
    "regexp/no-super-linear-move": "error",
    "regexp/no-invisible-character": "error",
    "no-irregular-whitespace": "error",
    // --- hygiene: warnings ---
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": "off",
    "regexp/no-unused-capturing-group": "warn",
    "regexp/use-ignore-case": "warn",
    "regexp/prefer-w": "warn",
  },
};
