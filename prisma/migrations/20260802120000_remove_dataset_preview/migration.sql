-- Le CSV brut ne doit jamais être conservé par Next, même sous forme d'échantillon.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Dataset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT NOT NULL,
    "mptIssuanceId" TEXT,
    "ipfsCid" TEXT,
    "wrappedKey" TEXT,
    "merkleRoot" TEXT,
    "sizeBytes" INTEGER,
    "metrics" JSONB,
    "runnerReceipt" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "keyDestroyedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_Dataset" (
    "id", "name", "description", "provider", "mptIssuanceId", "ipfsCid",
    "wrappedKey", "merkleRoot", "sizeBytes", "metrics", "runnerReceipt", "status",
    "keyDestroyedAt", "createdAt", "updatedAt"
)
SELECT
    "id", "name", "description", "provider", "mptIssuanceId", "ipfsCid",
    "wrappedKey", "merkleRoot", "sizeBytes", "metrics", "runnerReceipt", "status",
    "keyDestroyedAt", "createdAt", "updatedAt"
FROM "Dataset";

DROP TABLE "Dataset";
ALTER TABLE "new_Dataset" RENAME TO "Dataset";
CREATE UNIQUE INDEX "Dataset_mptIssuanceId_key" ON "Dataset"("mptIssuanceId");
CREATE INDEX "Dataset_provider_idx" ON "Dataset"("provider");
CREATE INDEX "Dataset_status_idx" ON "Dataset"("status");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
