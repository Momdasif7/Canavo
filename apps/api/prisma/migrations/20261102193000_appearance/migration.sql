-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "brand" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "preferences" JSONB NOT NULL DEFAULT '{}';

