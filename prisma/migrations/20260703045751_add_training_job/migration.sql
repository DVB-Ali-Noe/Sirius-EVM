-- CreateTable
CREATE TABLE "TrainingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "datasetId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "modelCid" TEXT,
    "metrics" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "TrainingJob_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrainingJob_datasetId_idx" ON "TrainingJob"("datasetId");

-- CreateIndex
CREATE INDEX "TrainingJob_owner_idx" ON "TrainingJob"("owner");

-- CreateIndex
CREATE INDEX "TrainingJob_status_idx" ON "TrainingJob"("status");
