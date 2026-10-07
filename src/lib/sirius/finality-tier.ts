import "server-only";
import { AppError } from "@/lib/errors";
import { prisma, serializableTransaction } from "@/lib/db";
import { fastFinalityPolicy } from "@/lib/evm/finality";
import { finalityTierFor, type FastFinalityConfig, type FinalityTier } from "@/lib/evm/fast-finality";

/**
 * Attribution du palier de finalité d'un prêt, côté Next (fast-finality.ts pour la politique).
 *
 * Le palier se décide au moment où l'entraînement peut démarrer (`prepareLoanResult`, prêt
 * ESCROWED), avec la somme des prêts rapides en cours lue dans la même transaction sérialisable
 * que l'écriture du palier : deux lancements simultanés ne peuvent pas se croire chacun seul sous
 * le plafond (même garde que l'exposition de la bêta, audit A-33). Un palier FAST est acquis : il
 * compte dans le plafond jusqu'à la clôture du prêt et s'applique aussi au règlement. Un palier
 * FULL est réévalué à chaque tentative : le plafond peut s'être libéré entre-temps.
 */

/** Statuts pendant lesquels un prêt rapide pèse sur le plafond global. */
export const FAST_IN_FLIGHT_STATUSES = ["ESCROWED", "TRAINING", "SETTLING"] as const;

export interface FinalityTierLoan {
  id: string;
  /** Montant dataset + calcul, égal aux termes on-chain (vérifié au passage en ESCROWED). */
  amountUsdcAtomic: string;
  finalityTier: FinalityTier;
}

/** Sous-ensemble du client Prisma utilisé par la décision, pour la tester sans base. */
export interface FinalityTierStore {
  loan: {
    findMany(args: {
      where: { finalityTier: "FAST"; status: { in: readonly string[] }; id?: { not: string } };
      select: { amountUsdcAtomic: true };
    }): Promise<{ amountUsdcAtomic: string }[]>;
    updateMany(args: {
      where: { id: string; status: "ESCROWED"; finalityTier: "FULL" };
      data: { finalityTier: "FAST" };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { id: string }; select: { finalityTier: true } }): Promise<{ finalityTier: FinalityTier } | null>;
  };
}

export async function fastInFlightAtomic(store: FinalityTierStore, excludeLoanId?: string): Promise<bigint> {
  const rows = await store.loan.findMany({
    where: { finalityTier: "FAST", status: { in: FAST_IN_FLIGHT_STATUSES }, ...(excludeLoanId ? { id: { not: excludeLoanId } } : {}) },
    select: { amountUsdcAtomic: true },
  });
  return rows.reduce<bigint>((sum, row) => sum + BigInt(row.amountUsdcAtomic), BigInt(0));
}

/**
 * Décision et marquage dans une transaction fournie par l'appelant. Renvoie le palier effectif
 * du prêt : `FAST` seulement si la ligne a bien été marquée (ou l'était déjà par un lancement
 * concurrent), `FULL` dans tous les autres cas.
 */
export async function decideFastTierInTransaction(
  store: FinalityTierStore,
  loan: FinalityTierLoan,
  config: FastFinalityConfig,
): Promise<FinalityTier> {
  const inFlightFastAtomic = await fastInFlightAtomic(store, loan.id);
  const tier = finalityTierFor({ amountAtomic: BigInt(loan.amountUsdcAtomic), inFlightFastAtomic, config });
  if (tier !== "FAST") return "FULL";
  const marked = await store.loan.updateMany({ where: { id: loan.id, status: "ESCROWED", finalityTier: "FULL" }, data: { finalityTier: "FAST" } });
  if (marked.count === 1) return "FAST";
  // Rien marqué : le prêt a changé d'état ou un lancement concurrent l'a déjà classé.
  const current = await store.loan.findUnique({ where: { id: loan.id }, select: { finalityTier: true } });
  return current?.finalityTier === "FAST" ? "FAST" : "FULL";
}

/**
 * Palier d'un prêt ESCROWED sur le point de démarrer. `verifyOnChainAmount` relit les termes du
 * contrat avant tout passage en rapide : le montant décidant du palier doit être celui de la
 * chaîne, jamais une valeur reçue du client. Les prêts hors seuil ne touchent ni la chaîne ni la
 * base. Coupe-circuit fermé ⇒ `FULL`, sans lecture.
 */
export async function assignLoanFinalityTier(
  loan: FinalityTierLoan,
  verifyOnChainAmount: () => Promise<boolean>,
  options: {
    config?: FastFinalityConfig;
    transaction?: <T>(action: (store: FinalityTierStore) => Promise<T>) => Promise<T>;
  } = {},
): Promise<FinalityTier> {
  if (loan.finalityTier === "FAST") return "FAST";
  const config = options.config ?? fastFinalityPolicy();
  if (!config.enabled) return "FULL";
  const amountAtomic = BigInt(loan.amountUsdcAtomic);
  if (finalityTierFor({ amountAtomic, inFlightFastAtomic: null, config }) !== "FAST") return "FULL";
  if (!(await verifyOnChainAmount())) throw new AppError("Montant on-chain du prêt différent du montant enregistré", 409);
  const transaction = options.transaction ?? ((action) => serializableTransaction((tx) => action(tx as unknown as FinalityTierStore)));
  return transaction((store) => decideFastTierInTransaction(store, loan, config));
}

/**
 * Palier que le prêt obtiendrait maintenant, sans rien écrire : pour l'affichage de l'attente
 * (`GET /api/loans/[id]/finality`). Un prêt déjà FAST le reste ; sinon même règle que ci-dessus,
 * la somme en cours lue hors transaction (indicatif, la décision reste au lancement).
 */
export async function prospectiveLoanFinalityTier(loan: FinalityTierLoan, store: FinalityTierStore = prisma as unknown as FinalityTierStore): Promise<FinalityTier> {
  if (loan.finalityTier === "FAST") return "FAST";
  const config = fastFinalityPolicy();
  if (!config.enabled) return "FULL";
  const amountAtomic = BigInt(loan.amountUsdcAtomic);
  if (finalityTierFor({ amountAtomic, inFlightFastAtomic: null, config }) !== "FAST") return "FULL";
  return finalityTierFor({ amountAtomic, inFlightFastAtomic: await fastInFlightAtomic(store, loan.id), config });
}
