import { execSync } from "node:child_process";

/** Drop + recreate the integration database and apply every migration. */
export default async function setup() {
  const url = new URL(process.env.IT_DATABASE_URL ?? "postgresql://canavo:canavo@localhost:5433/canavo_it?schema=public");
  const dbName = url.pathname.slice(1);
  if (!/^canavo_it\w*$/.test(dbName)) throw new Error(`Refusing to recreate "${dbName}": integration DB names must start with canavo_it`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  admin.search = "";
  const { PrismaClient } = await import("@prisma/client");
  const p = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await p.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await p.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  await p.$disconnect();
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url.toString() } });
}
