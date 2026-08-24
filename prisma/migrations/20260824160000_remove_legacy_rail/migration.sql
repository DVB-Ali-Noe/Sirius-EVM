UPDATE "Dataset"
SET "priceUsdcAtomic" = COALESCE("priceUsdcAtomic", '0'),
    "status" = CASE
      WHEN "evmDatasetId" IS NULL AND "status" <> 'DRAFT' THEN 'SUSPENDED'
      ELSE "status"
    END;

UPDATE "Loan"
SET "amountUsdcAtomic" = COALESCE("amountUsdcAtomic", '0'),
    "status" = CASE
      WHEN "evmLoanKey" IS NULL AND "status" NOT IN ('SETTLED', 'CANCELLED') THEN 'CANCELLED'
      ELSE "status"
    END;

UPDATE "Credential"
SET "status" = 'REVOKED'
WHERE "evmVerifier" IS NULL;

DROP INDEX "Dataset_mptIssuanceId_key";

ALTER TABLE "Dataset" DROP COLUMN "mptIssuanceId";
ALTER TABLE "Dataset" DROP COLUMN "mptTxHash";
ALTER TABLE "Dataset" DROP COLUMN "mptTxBlob";
ALTER TABLE "Dataset" DROP COLUMN "mptLastLedger";
ALTER TABLE "Dataset" DROP COLUMN "mptDestroyedAt";
ALTER TABLE "Dataset" DROP COLUMN "priceDrops";

ALTER TABLE "Loan" DROP COLUMN "amount";
ALTER TABLE "Loan" DROP COLUMN "currency";
ALTER TABLE "Loan" DROP COLUMN "escrowSequence";
ALTER TABLE "Loan" DROP COLUMN "escrowTxHash";
ALTER TABLE "Loan" DROP COLUMN "escrowTxBlob";
ALTER TABLE "Loan" DROP COLUMN "escrowLastLedger";
ALTER TABLE "Loan" DROP COLUMN "conditionHex";
ALTER TABLE "Loan" DROP COLUMN "cancelAfter";

ALTER TABLE "Credential" DROP COLUMN "domainId";
ALTER TABLE "Credential" DROP COLUMN "acceptTxBlob";
ALTER TABLE "Credential" DROP COLUMN "acceptLastLedger";
