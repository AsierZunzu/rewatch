-- AlterTable
ALTER TABLE "users" ADD COLUMN     "calendar_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_calendar_token_key" ON "users"("calendar_token");
