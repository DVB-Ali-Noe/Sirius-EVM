import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquante");

const adapter = new PrismaBetterSqlite3({ url });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// `omit` global : la DEK enveloppée ne doit JAMAIS sortir dans une réponse API.
// Les rares lectures serveur qui en ont besoin la ré-incluent via `omit: { wrappedKey: false }`.
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    omit: {
      dataset: {
        wrappedKey: true,
        mptTxHash: true,
        mptTxBlob: true,
        mptLastLedger: true,
      },
      loan: {
        escrowTxBlob: true,
      },
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
