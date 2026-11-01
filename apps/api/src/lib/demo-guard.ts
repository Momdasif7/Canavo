/** Seeded demo logins all use this domain and share a password published in the README. */
const DEMO_EMAIL = /@canavo\.local$/i;

interface DemoGuardDb {
  user: { findMany(args: { where: object; select: { email: true } }): Promise<{ email: string | null }[]> };
}

/**
 * Active demo logins (Phase 2.8). In production the API refuses to start while any exist:
 * they have a published password, so anyone could sign in as a hotel owner.
 */
export async function findDemoLogins(db: DemoGuardDb): Promise<string[]> {
  const users = await db.user.findMany({
    where: { status: "ACTIVE", email: { endsWith: "@canavo.local", mode: "insensitive" } },
    select: { email: true },
  });
  return users.map((u) => u.email ?? "").filter((e) => DEMO_EMAIL.test(e));
}

/** Startup check; ALLOW_DEMO_SEED=1 marks a throwaway demo environment where demo logins are intended. */
export async function assertNoDemoLogins(db: DemoGuardDb, env: { NODE_ENV: string; ALLOW_DEMO_SEED?: string }) {
  if (env.NODE_ENV !== "production" || env.ALLOW_DEMO_SEED === "1") return;
  const found = await findDemoLogins(db);
  if (found.length) {
    throw new Error(
      `Refusing to start in production: ${found.length} demo login(s) with the published password are active (${found.slice(0, 5).join(", ")}). ` +
        "Suspend or delete them, or set ALLOW_DEMO_SEED=1 for a throwaway demo environment.",
    );
  }
}
