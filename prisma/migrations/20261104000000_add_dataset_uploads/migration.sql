-- Upload jusqu'à 1 Go (docs/UPLOAD-1GO.md) : envois en morceaux vers R2. Table additive ; aucune
-- colonne existante ne change. La suppression d'un brouillon supprime ses envois.
-- CreateEnum
CREATE TYPE "DatasetUploadState" AS ENUM ('OPEN', 'SEALING', 'SEALED', 'FAILED', 'ABORTED');

-- CreateTable
CREATE TABLE "DatasetUpload" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "chunkBytes" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "state" "DatasetUploadState" NOT NULL DEFAULT 'OPEN',
    "manifestSha256" TEXT,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatasetUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DatasetUpload_datasetId_idx" ON "DatasetUpload"("datasetId");

-- CreateIndex
CREATE INDEX "DatasetUpload_provider_createdAt_idx" ON "DatasetUpload"("provider", "createdAt");

-- AddForeignKey
ALTER TABLE "DatasetUpload" ADD CONSTRAINT "DatasetUpload_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
