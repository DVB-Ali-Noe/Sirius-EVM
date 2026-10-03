-- Socle du passage au mainnet (A1). Migration strictement additive : aucune colonne
-- existante n'est modifiée ni supprimée, les nouvelles colonnes sont nullables ou
-- portent un défaut, les contraintes ne touchent que les tables créées ici.

-- Catalogue et consentement sur les datasets. La pause d'un dataset ne crée pas de
-- colonne : elle fait passer "status" de LISTED à UNLISTED (enum existant).
ALTER TABLE "Dataset" ADD COLUMN "category" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "listingExpiresAt" TIMESTAMP(3);
ALTER TABLE "Dataset" ADD COLUMN "trainingConsentAt" TIMESTAMP(3);
ALTER TABLE "Dataset" ADD COLUMN "trainingConsentVersion" TEXT;
ALTER TABLE "Dataset" ADD COLUMN "trainingConsentRevokedAt" TIMESTAMP(3);

-- Journal des accès aux datasets (traçage déclaré dans les conditions d'utilisation).
CREATE TABLE "DatasetAccessLog" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "loanId" TEXT,
    "address" TEXT NOT NULL,
    "modelCid" TEXT,
    "modelFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetAccessLog_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DatasetAccessLog_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "DatasetAccessLog_datasetId_idx" ON "DatasetAccessLog"("datasetId");
CREATE INDEX "DatasetAccessLog_address_idx" ON "DatasetAccessLog"("address");

-- Profils utilisateurs, une ligne par wallet en minuscules.
CREATE TABLE "UserProfile" (
    "address" TEXT NOT NULL,
    "tourCompletedAt" TIMESTAMP(3),
    "featureTours" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "kybStatus" TEXT,
    "kybCheckedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "blockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("address")
);
