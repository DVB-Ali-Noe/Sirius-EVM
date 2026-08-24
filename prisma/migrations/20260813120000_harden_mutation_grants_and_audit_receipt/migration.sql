ALTER TABLE "Loan" ADD COLUMN "auditTxHash" TEXT;

CREATE TABLE "MutationGrant" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "MutationGrant_expiresAt_idx" ON "MutationGrant"("expiresAt");
