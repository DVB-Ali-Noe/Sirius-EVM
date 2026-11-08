-- Budget de réveil de la CVM par compte (D-30, précision « budget de réveil ») : migration additive.
-- Une ligne par adresse (minuscules, comme UserProfile), deux fenêtres fixes dépensées atomiquement.
-- CreateTable
CREATE TABLE "RunnerWakeBudget" (
    "subject" TEXT NOT NULL,
    "hourStart" TIMESTAMP(3) NOT NULL,
    "hourCount" INTEGER NOT NULL,
    "dayStart" TIMESTAMP(3) NOT NULL,
    "dayCount" INTEGER NOT NULL,

    CONSTRAINT "RunnerWakeBudget_pkey" PRIMARY KEY ("subject"),
    CONSTRAINT "RunnerWakeBudget_subject_lowercase" CHECK ("subject" ~ '^0x[0-9a-f]{40}$')
);
