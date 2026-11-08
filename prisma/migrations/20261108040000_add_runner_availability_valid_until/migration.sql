-- Fraîcheur de la phase publiée par le contrôleur de disponibilité (D-30, audit E F4) : migration additive.
-- Null : ligne écrite par un contrôleur antérieur (phase lue comme avant) ou phase « maintenance ».
-- AlterTable
ALTER TABLE "RunnerAvailability" ADD COLUMN "validUntil" TIMESTAMP(3);
