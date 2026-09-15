-- T-019 provider-agnostic recognition contract: retain adapter confidence
-- independently for ASR and OCR so low-confidence results remain reviewable.
ALTER TABLE "MediaAsset"
  ADD COLUMN "transcriptionConfidence" DOUBLE PRECISION,
  ADD COLUMN "ocrConfidence" DOUBLE PRECISION;
