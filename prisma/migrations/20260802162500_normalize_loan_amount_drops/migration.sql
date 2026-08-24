UPDATE "Loan"
SET "amount" = CAST(CAST(ROUND(CAST("amount" AS REAL)) AS INTEGER) AS TEXT)
WHERE "currency" = 'XRP' AND "amount" LIKE '%.0';
