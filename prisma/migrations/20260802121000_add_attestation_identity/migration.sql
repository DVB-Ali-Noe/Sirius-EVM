-- Persist evidence required to replay RTMR3 and bind the measured compose.
ALTER TABLE "Loan" ADD COLUMN "attestationEventLog" TEXT;
ALTER TABLE "Loan" ADD COLUMN "attestationComposeHash" TEXT;
