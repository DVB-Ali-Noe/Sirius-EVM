-- Finalité rapide : palier par prêt, revérification à finalité complète et revue des divergences.
CREATE TYPE "FinalityTier" AS ENUM ('FULL', 'FAST');

ALTER TABLE "Loan"
ADD COLUMN "finalityTier" "FinalityTier" NOT NULL DEFAULT 'FULL',
ADD COLUMN "finalityVerifiedAt" TIMESTAMP(3),
ADD COLUMN "finalityReview" TEXT,
ADD COLUMN "finalityReviewAt" TIMESTAMP(3);

CREATE INDEX "Loan_finalityTier_status_idx" ON "Loan"("finalityTier", "status");
