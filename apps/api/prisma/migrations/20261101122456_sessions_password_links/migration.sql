-- CreateEnum
CREATE TYPE "PasswordTokenPurpose" AS ENUM ('RESET', 'INVITE');

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" "PasswordTokenPurpose" NOT NULL DEFAULT 'RESET',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_idx" ON "RefreshToken"("userId", "revokedAt");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (Phase 1.1 pattern): visible when the owning user is visible
ALTER TABLE "PasswordResetToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordResetToken" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PasswordResetToken";
CREATE POLICY tenant_isolation ON "PasswordResetToken" USING (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "PasswordResetToken"."userId")) WITH CHECK (canavo_rls_bypass() OR EXISTS (SELECT 1 FROM "User" parent WHERE parent."id" = "PasswordResetToken"."userId"));
