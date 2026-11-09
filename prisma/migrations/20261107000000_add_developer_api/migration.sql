-- API développeurs (D-30) : clés API des prêts loués, compteurs d'affichage, état de la CVM et
-- packs d'appels prépayés. Migration additive : aucune ligne existante n'est modifiée.
ALTER TABLE "Loan" ADD COLUMN "callPack" INTEGER,
ADD COLUMN "packForLoanId" TEXT;

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiUsageDay" (
    "keyId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "refused" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiUsageDay_pkey" PRIMARY KEY ("keyId","day")
);

-- CreateTable
CREATE TABLE "RunnerAvailability" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "phase" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "requestedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunnerAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKey_loanId_idx" ON "ApiKey"("loanId");

-- CreateIndex
CREATE INDEX "Loan_packForLoanId_idx" ON "Loan"("packForLoanId");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_packForLoanId_fkey" FOREIGN KEY ("packForLoanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiUsageDay" ADD CONSTRAINT "ApiUsageDay_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
