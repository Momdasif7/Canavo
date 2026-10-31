/**
 * Create the first platform Super Admin on a fresh (production) database.
 *   ADMIN_NAME="Asha" ADMIN_EMAIL=admin@example.in ADMIN_PHONE=98xxxxxxxx ADMIN_PASSWORD='…' \
 *     npm run create-admin -w @canavo/api
 * Refuses weak passwords and existing logins. Run once from the Render shell.
 */
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const { ADMIN_NAME: name, ADMIN_EMAIL: email, ADMIN_PHONE: phone, ADMIN_PASSWORD: password } = process.env;
  if (!name || !email || !phone || !password) throw new Error("Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE and ADMIN_PASSWORD");
  if (!/^[6-9]\d{9}$/.test(phone)) throw new Error("ADMIN_PHONE must be a 10-digit Indian mobile number");
  if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters with upper case, lower case and a digit");
  }
  const clash = await prisma.user.findFirst({ where: { OR: [{ email: email.toLowerCase() }, { phone }] }, select: { id: true } });
  if (clash) throw new Error("A user with this email or phone already exists");
  const user = await prisma.user.create({
    data: { role: "SUPER_ADMIN", name, email: email.toLowerCase(), phone, passwordHash: await bcrypt.hash(password, 10) },
    select: { id: true, email: true },
  });
  console.info(`Created platform Super Admin ${user.email} (${user.id})`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
