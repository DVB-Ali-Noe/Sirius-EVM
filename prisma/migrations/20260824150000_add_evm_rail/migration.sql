ALTER TABLE "Dataset" ADD COLUMN "evmDatasetId" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "evmMintTxHash" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "evmMintBlock" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "evmDestroyTxHash" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "priceUsdcAtomic" TEXT;

ALTER TABLE "Loan" ADD COLUMN "evmLoanKey" TEXT;
ALTER TABLE "Loan" ADD COLUMN "evmHashlock" TEXT;
ALTER TABLE "Loan" ADD COLUMN "evmLockTxHash" TEXT;
ALTER TABLE "Loan" ADD COLUMN "evmLockBlock" TEXT;
ALTER TABLE "Loan" ADD COLUMN "evmDeadline" DATETIME;
ALTER TABLE "Loan" ADD COLUMN "amountUsdcAtomic" TEXT;

ALTER TABLE "Credential" ADD COLUMN "evmVerifier" TEXT;
ALTER TABLE "Credential" ADD COLUMN "evmExpiresAt" DATETIME;
ALTER TABLE "Credential" ADD COLUMN "evmAttestationTxHash" TEXT;

CREATE UNIQUE INDEX "Dataset_evmDatasetId_key" ON "Dataset"("evmDatasetId");
CREATE UNIQUE INDEX "Loan_evmLoanKey_key" ON "Loan"("evmLoanKey");
