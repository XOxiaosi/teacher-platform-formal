-- T-017: attended -> absent -> attended must retain each correction as an
-- immutable ledger entry. lessonId therefore cannot be globally unique.
DROP INDEX IF EXISTS "LessonLedgerEntry_lessonId_key";

CREATE INDEX "LessonLedgerEntry_lessonId_createdAtTs_idx"
  ON "LessonLedgerEntry"("lessonId", "createdAtTs");
