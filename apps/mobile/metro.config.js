// Metro config for a standalone Expo app that consumes the monorepo's
// `packages/shared` through a `file:` dependency (a symlink in node_modules).
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "../..");
const sharedRoot = path.resolve(repoRoot, "packages/shared");

const config = getDefaultConfig(projectRoot);

// Let Metro see (and hash) files behind the @canavo/shared symlink.
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];

// Resolve packages from this app's own node_modules. The repo-root
// node_modules belongs to the npm workspaces (api/web) and is deliberately
// not used, so the mobile bundle never depends on its contents.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Bare imports made from inside packages/shared (e.g. `zod`) would otherwise
// walk up to the repo-root node_modules. Resolve them as if they were
// imported from the app, so there is one copy of each dependency.
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isBare = !moduleName.startsWith(".") && !path.isAbsolute(moduleName);
  const fromShared = context.originModulePath.startsWith(sharedRoot + path.sep);
  const ctx =
    isBare && fromShared ? { ...context, originModulePath: path.join(projectRoot, "package.json") } : context;
  return defaultResolve ? defaultResolve(ctx, moduleName, platform) : ctx.resolveRequest(ctx, moduleName, platform);
};

module.exports = config;
