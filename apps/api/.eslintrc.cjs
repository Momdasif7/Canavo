module.exports = {
  root: true,
  extends: ["../../.eslintrc.node.cjs"],
  parserOptions: { project: ["./tsconfig.lint.json"], tsconfigRootDir: __dirname },
  ignorePatterns: ["dist", "node_modules", "*.config.ts", ".eslintrc.cjs"],
};
