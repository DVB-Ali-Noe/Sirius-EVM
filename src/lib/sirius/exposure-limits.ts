import { AppError } from "@/lib/errors";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";

/**
 * Plafonds de la bêta mainnet : montant maximal d'un prêt (dataset + calcul) et exposition
 * totale verrouillée sur l'ensemble des prêts en cours. Le contrat n'a ni plafond ni pause :
 * c'est l'application qui borne ce qu'un lancement sans audit externe peut exposer.
 *
 * Sur mainnet les deux valeurs sont obligatoires ; sur testnet elles restent facultatives.
 */
export interface ExposureLimits {
  maxLoanAtomic: bigint;
  maxExposureAtomic: bigint;
}

/** Statuts dont les fonds sont verrouillés ou en passe de l'être. */
export const EXPOSED_LOAN_STATUSES = ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] as const;

type Env = Record<string, string | undefined>;

function parseLimit(env: Env, name: string): bigint | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const atomic = priceUsdcToAtomic(raw);
  if (!atomic) throw new AppError(`${name} invalide : montant USDC positif attendu`, 503);
  return BigInt(atomic);
}

export function exposureLimits(env: Env = process.env): ExposureLimits | null {
  const mainnet = (env.EVM_NETWORK?.trim() || "testnet") === "mainnet";
  const maxLoanAtomic = parseLimit(env, "SIRIUS_MAX_LOAN_USDC");
  const maxExposureAtomic = parseLimit(env, "SIRIUS_MAX_EXPOSURE_USDC");
  if (maxLoanAtomic === null || maxExposureAtomic === null) {
    if (mainnet) throw new AppError("Plafonds de prêt non configurés sur mainnet", 503);
    if (maxLoanAtomic !== null || maxExposureAtomic !== null) {
      throw new AppError("Les deux plafonds de prêt doivent être configurés ensemble", 503);
    }
    return null;
  }
  if (maxLoanAtomic > maxExposureAtomic) throw new AppError("Plafond par prêt supérieur à l’exposition totale", 503);
  return { maxLoanAtomic, maxExposureAtomic };
}

export function assertLoanWithinCap(amountAtomic: string | bigint, limits: ExposureLimits | null): void {
  if (limits && BigInt(amountAtomic) > limits.maxLoanAtomic) {
    throw new AppError("Montant au-delà du plafond par prêt de la bêta", 409);
  }
}

export function assertExposureWithinCap(
  exposedAtomic: readonly (string | bigint)[],
  addedAtomic: string | bigint,
  limits: ExposureLimits | null,
): void {
  if (!limits) return;
  const total = exposedAtomic.reduce<bigint>((sum, value) => sum + BigInt(value), BigInt(addedAtomic));
  if (total > limits.maxExposureAtomic) {
    throw new AppError("Plafond d’exposition totale de la bêta atteint, réessaie plus tard", 409);
  }
}
