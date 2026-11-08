/* Global mocks for the jest-expo test suite (native modules that have no JS fallback). */
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---- expo-sqlite → a real SQLite file through node:sqlite, so SQL is exercised for real and
// "kill / restart the app" = drop the JS modules and reopen the same file (see test/helpers.ts).
const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "canavo-mob-sqlite-"));
globalThis.__SQLITE_DIR__ = sqliteDir;

jest.mock("expo-sqlite", () => {
  const nodePath = jest.requireActual("path");
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const norm = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
  return {
    openDatabaseAsync: async (name) => {
      const dir = globalThis.__SQLITE_DIR__;
      const d = new DatabaseSync(nodePath.join(dir, name));
      return {
        execAsync: async (sql) => void d.exec(sql),
        runAsync: async (sql, ...args) => {
          const r = d.prepare(sql).run(...norm(args));
          return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
        },
        getFirstAsync: async (sql, ...args) => {
          const row = d.prepare(sql).get(...norm(args));
          return row ? { ...row } : null;
        },
        getAllAsync: async (sql, ...args) => d.prepare(sql).all(...norm(args)).map((r) => ({ ...r })),
        closeAsync: async () => d.close(),
      };
    },
  };
});

// ---- expo-secure-store → in-memory (survives jest.resetModules via globalThis, like the keychain).
jest.mock("expo-secure-store", () => {
  const store = (globalThis.__SECURE__ ??= new Map());
  return {
    getItemAsync: async (k) => store.get(k) ?? null,
    setItemAsync: async (k, v) => void store.set(k, v),
    deleteItemAsync: async (k) => void store.delete(k),
  };
});

jest.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` };
});

jest.mock("@react-native-community/netinfo", () => {
  const listeners = new Set();
  globalThis.__NETINFO__ = {
    emit: (state) => listeners.forEach((l) => l(state)),
  };
  const mod = {
    addEventListener: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  };
  return { __esModule: true, default: mod, ...mod };
});

jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success", Error: "error", Warning: "warning" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));

afterAll(() => {
  // Each test file gets its own setup run; tidy its SQLite folder.
  try {
    fs.rmSync(sqliteDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
