-- P2 用户发言需求追溯（additive）：UserRequirement
-- 只建表/索引/外键，绝不动既有表。
-- 时间列 TIMESTAMPTZ(3)、默认 CURRENT_TIMESTAMP、索引 *_idx、外键 ON DELETE SET NULL ON UPDATE CASCADE
-- （teacherId 可空：平台级需求无 owner；删除教师时需求保留但 owner 置空——追溯留证优先）。
-- 风格对齐 20260830000000_add_p7_auth_models。

-- CreateTable
CREATE TABLE "UserRequirement" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT,
    "verbatimQuote" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceDbName" TEXT,
    "sourceTurnId" TEXT,
    "contextSummary" TEXT,
    "occurredAtTs" TIMESTAMPTZ(3) NOT NULL,
    "parsedIntent" TEXT,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'new',
    "linkedDesignDoc" TEXT,
    "linkedTaskId" TEXT,
    "linkedCommitSha" TEXT,
    "createdAtTs" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAtTs" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRequirement_teacherId_idx" ON "UserRequirement"("teacherId");

-- CreateIndex
CREATE INDEX "UserRequirement_status_idx" ON "UserRequirement"("status");

-- CreateIndex
CREATE INDEX "UserRequirement_category_idx" ON "UserRequirement"("category");

-- AddForeignKey
ALTER TABLE "UserRequirement" ADD CONSTRAINT "UserRequirement_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "TeacherRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
