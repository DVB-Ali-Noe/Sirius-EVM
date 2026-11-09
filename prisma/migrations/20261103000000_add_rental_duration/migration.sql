-- Location des modèles de prêt (D-29) : `Dataset.priceUsdcAtomic` devient le prix par jour.
-- Colonnes additives ; un prêt sans `rentalDays` est un prêt hérité, sans expiration.
ALTER TABLE "Dataset" ADD COLUMN "maxRentalDays" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "Loan" ADD COLUMN "rentalDays" INTEGER,
ADD COLUMN "rentalExpiresAt" TIMESTAMP(3),
ADD COLUMN "extendsLoanId" TEXT;

-- CreateIndex
CREATE INDEX "Loan_extendsLoanId_idx" ON "Loan"("extendsLoanId");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_extendsLoanId_fkey" FOREIGN KEY ("extendsLoanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
