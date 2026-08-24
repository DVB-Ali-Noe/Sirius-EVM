-- CreateTable
CREATE TABLE "AuthChallenge" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");
