-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL,
    "mptIssuanceId" TEXT,
    "ipfsCid" TEXT,
    "merkleRoot" TEXT,
    "sizeBytes" INTEGER,
    "metrics" JSONB,
    "samplePreview" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "borrower" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RLUSD',
    "escrowSequence" INTEGER,
    "escrowTxHash" TEXT,
    "conditionHex" TEXT,
    "cancelAfter" DATETIME,
    "jobId" TEXT,
    "modelCid" TEXT,
    "attestationHash" TEXT,
    "settleTxHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "settledAt" DATETIME,
    CONSTRAINT "Loan_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KeyGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "loanId" TEXT,
    "grantee" TEXT NOT NULL,
    "keyRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "KeyGrant_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "KeyGrant_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subject" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "credType" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "domainId" TEXT,
    "txHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Reputation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "score" REAL NOT NULL DEFAULT 0,
    "completedLoans" INTEGER NOT NULL DEFAULT 0,
    "disputes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_mptIssuanceId_key" ON "Dataset"("mptIssuanceId");

-- CreateIndex
CREATE INDEX "Dataset_provider_idx" ON "Dataset"("provider");

-- CreateIndex
CREATE INDEX "Dataset_status_idx" ON "Dataset"("status");

-- CreateIndex
CREATE INDEX "Loan_datasetId_idx" ON "Loan"("datasetId");

-- CreateIndex
CREATE INDEX "Loan_borrower_idx" ON "Loan"("borrower");

-- CreateIndex
CREATE INDEX "Loan_status_idx" ON "Loan"("status");

-- CreateIndex
CREATE INDEX "KeyGrant_datasetId_idx" ON "KeyGrant"("datasetId");

-- CreateIndex
CREATE INDEX "KeyGrant_loanId_idx" ON "KeyGrant"("loanId");

-- CreateIndex
CREATE INDEX "Credential_subject_idx" ON "Credential"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_subject_credType_key" ON "Credential"("subject", "credType");

-- CreateIndex
CREATE UNIQUE INDEX "Reputation_address_key" ON "Reputation"("address");
