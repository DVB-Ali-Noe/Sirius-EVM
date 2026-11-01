ALTER TABLE "TrainingJob" ADD COLUMN "servedModelId" TEXT;
CREATE UNIQUE INDEX "TrainingJob_servedModelId_key" ON "TrainingJob"("servedModelId");
