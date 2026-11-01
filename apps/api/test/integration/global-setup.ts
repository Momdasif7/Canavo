import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/** Drop + recreate the integration database and apply every migration. */
export default async function setup() {
  const url = new URL(process.env.IT_DATABASE_URL ?? "postgresql://canavo:canavo@localhost:5433/canavo_it?schema=public");
  const dbName = url.pathname.slice(1);
  if (!/^canavo_it\w*$/.test(dbName)) throw new Error(`Refusing to recreate "${dbName}": integration DB names must start with canavo_it`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  admin.search = "";
  const p = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  await p.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await p.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  await p.$disconnect();
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url.toString() } });

  // The app role: login, no superuser, no BYPASSRLS — like a production database user.
  const app = new URL(process.env.IT_APP_DATABASE_URL ?? "postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_it?schema=public");
  const role = decodeURIComponent(app.username);
  const owner = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" LOGIN PASSWORD '${decodeURIComponent(app.password)}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  await owner.$executeRawUnsafe(`GRANT CONNECT, CREATE ON DATABASE "${dbName}" TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${role}"`);
  await owner.$disconnect();
}
