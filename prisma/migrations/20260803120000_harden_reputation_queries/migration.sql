DROP INDEX "Reputation_address_key";

CREATE INDEX "Loan_provider_status_idx" ON "Loan"("provider", "status");
CREATE INDEX "Loan_borrower_status_idx" ON "Loan"("borrower", "status");
CREATE UNIQUE INDEX "Reputation_address_role_key" ON "Reputation"("address", "role");
