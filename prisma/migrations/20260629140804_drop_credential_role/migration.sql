/*
  Warnings:

  - You are about to drop the column `role` on the `Credential` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subject" TEXT NOT NULL,
    "credType" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "domainId" TEXT,
    "txHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME
);
INSERT INTO "new_Credential" ("acceptedAt", "createdAt", "credType", "domainId", "id", "issuer", "status", "subject", "txHash") SELECT "acceptedAt", "createdAt", "credType", "domainId", "id", "issuer", "status", "subject", "txHash" FROM "Credential";
DROP TABLE "Credential";
ALTER TABLE "new_Credential" RENAME TO "Credential";
CREATE INDEX "Credential_subject_idx" ON "Credential"("subject");
CREATE UNIQUE INDEX "Credential_subject_credType_key" ON "Credential"("subject", "credType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
