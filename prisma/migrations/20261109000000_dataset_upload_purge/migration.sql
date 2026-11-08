-- Audit D (envoi 1 Go) : un envoi en morceaux ne disparaît plus avec son brouillon. Additif : une
-- colonne nullable, un index, et la clé étrangère passe de CASCADE à RESTRICT (aucune donnée ne change).
-- `purgedAt` vide = morceaux R2 encore à supprimer par le reaper ; les envois FAILED/ABORTED déjà
-- présents seront donc purgés une fois de plus (sans effet si leur préfixe R2 est déjà vide).

-- AlterTable
ALTER TABLE "DatasetUpload" ADD COLUMN "purgedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DatasetUpload_state_purgedAt_idx" ON "DatasetUpload"("state", "purgedAt");

-- DropForeignKey
ALTER TABLE "DatasetUpload" DROP CONSTRAINT "DatasetUpload_datasetId_fkey";

-- AddForeignKey
ALTER TABLE "DatasetUpload" ADD CONSTRAINT "DatasetUpload_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
