-- Pass d'accès API payé au jour (D-32) : jours achetés et refus définitif (pass caduc) sur le prêt
-- de pass, fin de couverture reflétée sur le prêt d'origine. Migration additive : aucune ligne
-- existante n'est modifiée.
ALTER TABLE "Loan" ADD COLUMN "apiAccessDays" INTEGER,
ADD COLUMN "apiAccessRefusedAt" TIMESTAMP(3),
ADD COLUMN "apiPaidUntil" TIMESTAMP(3);
