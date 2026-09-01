-- P7 认证地基（additive）：TeacherRegistry + SessionStore
-- 只建表/索引/外键，绝不动既有表。
-- 时间列 TIMESTAMPTZ(3)、默认 CURRENT_TIMESTAMP、索引 *_idx、外键 ON DELETE RESTRICT ON UPDATE CASCADE，
-- 风格对齐 20260823000000_add_d40_feedback_snapshot。

-- CreateTable
CREATE TABLE "TeacherRegistry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "databaseName" TEXT NOT NULL DEFAULT 'teacher_platform',
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TeacherRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionStore" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "expiresAtTs" TIMESTAMPTZ(3) NOT NULL,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SessionStore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherRegistry_email_key" ON "TeacherRegistry"("email");

-- CreateIndex
CREATE INDEX "TeacherRegistry_status_idx" ON "TeacherRegistry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SessionStore_tokenHash_key" ON "SessionStore"("tokenHash");

-- CreateIndex
CREATE INDEX "SessionStore_teacherId_idx" ON "SessionStore"("teacherId");

-- AddForeignKey
ALTER TABLE "SessionStore" ADD CONSTRAINT "SessionStore_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherRegistry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
