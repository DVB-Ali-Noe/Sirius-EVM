import "server-only";
import { prisma } from "@/lib/db";
import { billingEnabled } from "@/lib/billing/config";
import { getPublicClient } from "@/lib/evm/client";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { resolveServerNetwork, USDC_DECIMALS_BY_NETWORK } from "@/lib/evm/networks";
import { USDC_DECIMALS } from "@/lib/evm/usdc";
import { AppError } from "@/lib/app-error";
import { publishedTariff } from "@/lib/datasets/tariff-server";
import { newRentalApiAccessDailyFee } from "@/lib/sirius/api-keys";
import type { ModelId } from "@/lib/models/registry";
import type { BillingMode, MarketplaceDb, MarketplaceDeps } from "./catalogue";
import type { ApiAccessFee } from "./listing";
import { createKybStatusReader } from "./kyb";
import { marketplaceToken } from "./token";

/**
 * Branchement réel des dépendances de la marketplace publique : base, registre KYB, facturation.
 * Séparé de `catalogue.ts` pour que la logique se teste sans base ni RPC.
 */

const kybStatuses = createKybStatusReader((address) =>
  getPublicClient().readContract({
    address: kybRegistryAddress(),
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  }),
);

/**
 * Adaptateur explicite plutôt qu'un transtypage de `prisma` : chaque appel est vérifié par les
 * types générés de Prisma, et seules ces quatre opérations de lecture sont joignables.
 */
const db: MarketplaceDb = {
  dataset: {
    findMany: (args) => prisma.dataset.findMany(args),
    findFirst: (args) => prisma.dataset.findFirst(args),
  },
  loan: {
    groupBy: async (args) => {
      const rows = await prisma.loan.groupBy({ by: ["datasetId"], where: args.where, _count: { _all: true } });
      return rows.map((row) => ({ datasetId: row.datasetId, _count: { _all: row._count._all } }));
    },
    findFirst: (args) => prisma.loan.findFirst(args),
  },
};

function billingMode(): BillingMode {
  try {
    return billingEnabled() ? "v7" : "v6";
  } catch {
    return "unknown";
  }
}

/** Même règle que `prepareLoan` : un profil dont la location serait refusée faute de tarif API est `unavailable`. */
function apiAccessFee(modelId: ModelId): ApiAccessFee {
  try {
    const atomic = newRentalApiAccessDailyFee(modelId);
    return atomic === null ? { kind: "none" } : { kind: "included", atomic };
  } catch {
    return { kind: "unavailable" };
  }
}

export function marketplaceDeps(): MarketplaceDeps {
  const { network } = resolveServerNetwork();
  const token = marketplaceToken(network);
  // Les montants stockés suivent `USDC_DECIMALS` (résolu au chargement depuis le même
  // environnement) : un écart signalerait une configuration incohérente, pas un détail d'affichage.
  if (token.decimals !== USDC_DECIMALS || token.decimals !== USDC_DECIMALS_BY_NETWORK[network]) {
    throw new AppError("Configuration du réseau incohérente", 503);
  }
  return {
    db,
    kybStatuses,
    billingMode,
    // Un tarif dans une autre précision que le jeton affiché n'est pas repris.
    publishedComputeFees: () => {
      const tariff = publishedTariff();
      return tariff && tariff.decimals === token.decimals ? tariff.computeFeeAtomic : null;
    },
    apiAccessFee,
    token,
    now: () => new Date(),
  };
}
