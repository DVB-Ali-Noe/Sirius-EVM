import { AppError } from "@/lib/app-error";

/**
 * Plafond quotidien global de l'assistant, tenu en base pour valoir d'une instance serverless à
 * l'autre (`AssistantUsage`, une ligne par jour UTC). Deux écritures atomiques, jamais de lecture
 * puis écriture : en parallèle sur plusieurs instances, la k-ième requête voit les k − 1
 * précédentes. Le compteur ne contient aucun contenu de message.
 */

/** Sous-ensemble du client Prisma utilisé ici, injectable dans les tests. */
export interface AssistantUsageStore {
  updateMany(args: { where: { day: string; count: { lt: number } }; data: { count: { increment: number } } }): Promise<{ count: number }>;
  create(args: { data: { day: string; count: number } }): Promise<unknown>;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

/**
 * Réserve une requête pour le jour donné ; lève 429 quand le plafond est atteint.
 *   1. incrémente la ligne du jour si elle existe et reste sous le plafond ;
 *   2. sinon crée la ligne à 1 ; une création concurrente (P2002) signifie que la ligne vient
 *      d'apparaître : on retente l'incrément une fois, puis on refuse.
 */
export async function reserveAssistantRequest(store: AssistantUsageStore, day: string, cap: number): Promise<void> {
  const refused = new AppError("Assistant indisponible aujourd’hui : plafond quotidien atteint", 429);
  if (cap < 1) throw refused;
  const increment = () => store.updateMany({ where: { day, count: { lt: cap } }, data: { count: { increment: 1 } } });
  if ((await increment()).count === 1) return;
  try {
    await store.create({ data: { day, count: 1 } });
    return;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  if ((await increment()).count === 1) return;
  throw refused;
}
