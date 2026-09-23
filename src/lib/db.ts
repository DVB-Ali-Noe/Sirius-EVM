import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL manquante");

// Adaptateur Postgres générique plutôt que celui propre à Neon : le même code sert
// à la base managée derrière Vercel et à un Postgres rapatrié sur le VPS, sans que
// le choix d'hébergement se retrouve figé dans l'application.
//
// La taille du pool est volontairement basse. L'application tourne en serverless :
// chaque instance froide ouvre son propre pool, et une valeur généreuse par instance
// épuise les connexions de la base bien avant d'être utile.
const adapter = new PrismaPg({
  connectionString: url,
  max: Number(process.env.DATABASE_POOL_MAX ?? 5),
});

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
      },
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export async function serializableTransaction<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(action, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2034" || attempt === 2) throw error;
    }
  }
}
