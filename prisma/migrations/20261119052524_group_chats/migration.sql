-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'MEMBER');

-- AlterTable
ALTER TABLE "chat_members" ADD COLUMN     "role" "MemberRole" NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE "chats" ADD COLUMN     "name" VARCHAR(100);

-- A GROUP chat always has a name; a DIRECT chat never does.
ALTER TABLE "chats" ADD CONSTRAINT "chats_name_matches_type"
  CHECK (("type" = 'GROUP') = ("name" IS NOT NULL));
-- At most one OWNER per chat.
CREATE UNIQUE INDEX "chat_members_one_owner_per_chat" ON "chat_members"("chat_id") WHERE "role" = 'OWNER';
