-- T-014 邀请制账号入口（additive）：只保存 token 哈希，保留接受/撤销审计时间。
-- 不修改既有 TeacherRegistry / SessionStore，适用于 PostgreSQL 17。

CREATE TABLE "TeacherInvitation" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAtTs" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAtTs" TIMESTAMPTZ(3),
    "revokedAtTs" TIMESTAMPTZ(3),
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TeacherInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeacherInvitation_tokenHash_key" ON "TeacherInvitation"("tokenHash");
CREATE INDEX "TeacherInvitation_email_status_idx" ON "TeacherInvitation"("email", "status");
CREATE INDEX "TeacherInvitation_status_expiresAtTs_idx" ON "TeacherInvitation"("status", "expiresAtTs");
