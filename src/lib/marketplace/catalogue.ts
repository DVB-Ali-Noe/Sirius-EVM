import "server-only";
import { MODEL_REGISTRY, type ModelId } from "@/lib/models/registry";
import type { TokenInfo } from "@/components/datasets/price";
import type { Prisma } from "@/generated/prisma/client";
import {
  EMPTY_LOAN_STATS,
  feeForRow,
  filterAndSortListings,
  isOnlineDataset,
  MARKETPLACE_DATASET_SELECT,
  onlineDatasetWhere,
  paginate,
  searchableText,
  toPublicDetail,
  toPublicListing,
  UNKNOWN_COMPUTE_FEE,
  type ComputeFee,
  type ComputeFees,
  type ListingCandidate,
  type ListingPage,
  type LoanStats,
  type MarketplaceDatasetRow,
  type PublicDetail,
} from "./listing";
import { MARKETPLACE_MAX_CANDIDATES, type MarketplaceQuery } from "./query";

/**
 * Lecture publique du catalogue, sans session.
 *
 * Les dépendances (base, registre KYB, configuration de facturation, horloge) sont injectées
 * par la route : ce module ne charge ni `src/lib/db.ts` ni le client EVM, et se teste avec de
 * faux objets. Aucune donnée liée au visiteur n'entre ici : la réponse est la même pour tous.
 */

/** Sous-ensemble de Prisma utilisé, typé au plus juste pour les faux objets des tests. */
export interface MarketplaceDb {
  dataset: {
    findMany(args: {
      where: ReturnType<typeof onlineDatasetWhere>;
      select: typeof MARKETPLACE_DATASET_SELECT;
      orderBy: Array<Record<string, "asc" | "desc">>;
      take: number;
    }): Promise<MarketplaceDatasetRow[]>;
    findFirst(args: {
      where: ReturnType<typeof onlineDatasetWhere> & { id: string };
      select: typeof MARKETPLACE_DATASET_SELECT;
    }): Promise<MarketplaceDatasetRow | null>;
  };
  loan: {
    groupBy(args: {
      by: ["datasetId"];
      where: Prisma.LoanWhereInput;
      _count: { _all: true };
    }): Promise<Array<{ datasetId: string; _count: { _all: number } }>>;
    findFirst(args: {
      where: Prisma.LoanWhereInput;
      orderBy: { createdAt: "desc" };
      select: { computeAmountUsdcAtomic: true; createdAt: true };
    }): Promise<{ computeAmountUsdcAtomic: string | null; createdAt: Date } | null>;
  };
}

/** Version de facturation lue dans la configuration serveur ; `unknown` si illisible. */
export type BillingMode = "v6" | "v7" | "unknown";

export interface MarketplaceDeps {
  db: MarketplaceDb;
  /** Statut KYB par adresse (minuscules) : `true`, `false`, ou `null` si illisible. */
  kybStatuses(addresses: readonly string[]): Promise<Map<string, boolean | null>>;
  billingMode(): BillingMode;
  token: TokenInfo;
  now(): Date;
}

/** Un devis plus ancien ne reflète plus forcément le tarif en vigueur : il n'est pas affiché. */
export const COMPUTE_QUOTE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ATOMIC = /^[1-9][0-9]{0,77}$/;

/** Statuts d'un prêt dont les fonds ont été verrouillés dans l'escrow. */
const LOCKED_STATUSES = ["ESCROWED", "TRAINING", "SETTLING", "SETTLED"] as const;

async function loanStatsFor(db: MarketplaceDb, ids: readonly string[]): Promise<Map<string, LoanStats>> {
  const stats = new Map<string, LoanStats>();
  if (ids.length === 0) return stats;
  const datasetId = { in: [...ids] };
  const [borrowed, settled, refunded] = await Promise.all([
    db.loan.groupBy({
      by: ["datasetId"],
      where: {
        datasetId,
        OR: [{ status: { in: [...LOCKED_STATUSES] } }, { status: "CANCELLED", cancelTxHash: { not: null } }],
      },
      _count: { _all: true },
    }),
    db.loan.groupBy({
      by: ["datasetId"],
      where: { datasetId, status: "SETTLED", settleTxHash: { not: null } },
      _count: { _all: true },
    }),
    db.loan.groupBy({
      by: ["datasetId"],
      where: { datasetId, status: "CANCELLED", cancelTxHash: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const entry = (id: string) => {
    const current = stats.get(id) ?? { ...EMPTY_LOAN_STATS };
    stats.set(id, current);
    return current;
  };
  for (const row of borrowed) entry(row.datasetId).borrowCount = row._count._all;
  for (const row of settled) entry(row.datasetId).settledCount = row._count._all;
  for (const row of refunded) entry(row.datasetId).refundedCount = row._count._all;
  return stats;
}

/**
 * Frais de calcul par profil. En v7, le tarif n'est connu que du runner : on reprend le montant
 * du dernier devis signé pour ce profil (identique pour tous les emprunteurs, et public on-chain
 * dans les conditions du lock), s'il date de moins de 30 jours. Le devis présenté avant paiement
 * reste la seule valeur qui engage.
 */
export async function computeFeesFor(db: MarketplaceDb, mode: BillingMode, now: Date): Promise<ComputeFees> {
  const ids = Object.keys(MODEL_REGISTRY) as ModelId[];
  if (mode === "v6") {
    return Object.fromEntries(ids.map((id) => [id, { kind: "none", atomic: "0" }])) as ComputeFees;
  }
  if (mode !== "v7") {
    return Object.fromEntries(ids.map((id) => [id, UNKNOWN_COMPUTE_FEE])) as ComputeFees;
  }
  const since = new Date(now.getTime() - COMPUTE_QUOTE_MAX_AGE_MS);
  const entries = await Promise.all(ids.map(async (id): Promise<[ModelId, ComputeFee]> => {
    const latest = await db.loan.findFirst({
      where: { modelId: id, computeAmountUsdcAtomic: { not: null }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: { computeAmountUsdcAtomic: true, createdAt: true },
    });
    const amount = latest?.computeAmountUsdcAtomic;
    if (!latest || typeof amount !== "string" || !ATOMIC.test(amount) || !(latest.createdAt instanceof Date)) {
      return [id, UNKNOWN_COMPUTE_FEE];
    }
    // La date du devis n'est pas renvoyée : elle dirait quand quelqu'un a préparé un emprunt.
    return [id, { kind: "quoted", atomic: amount }];
  }));
  return Object.fromEntries(entries) as ComputeFees;
}

async function kybFor(deps: MarketplaceDeps, providers: readonly string[]): Promise<Map<string, boolean | null>> {
  try {
    return await deps.kybStatuses([...new Set(providers)]);
  } catch {
    return new Map();
  }
}

function kybAvailable(statuses: Map<string, boolean | null>, providers: readonly string[]): boolean {
  return providers.every((provider) => typeof statuses.get(provider) === "boolean");
}

export interface CatalogueResponse extends ListingPage {
  /** Le plafond de lecture a été atteint : des datasets plus anciens peuvent manquer. */
  truncated: boolean;
  token: TokenInfo;
  computeFees: ComputeFees;
  /** Faux si le statut KYB d'au moins un fournisseur n'a pas pu être lu. */
  kybAvailable: boolean;
}

export async function loadCatalogue(query: MarketplaceQuery, deps: MarketplaceDeps): Promise<CatalogueResponse> {
  const now = deps.now();
  const rows = await deps.db.dataset.findMany({
    where: onlineDatasetWhere(now),
    select: MARKETPLACE_DATASET_SELECT,
    // Ordre de lecture seulement (le tri affiché se fait après) : au-delà du plafond, ce sont
    // les datasets les plus anciennement créés qui manquent, et la réponse le signale.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MARKETPLACE_MAX_CANDIDATES + 1,
  });
  const truncated = rows.length > MARKETPLACE_MAX_CANDIDATES;
  const online = rows.slice(0, MARKETPLACE_MAX_CANDIDATES).filter((row) => isOnlineDataset(row, now));

  const ids = online.map((row) => row.id);
  // Le KYB n'est lu que si le filtre ou l'affichage en a besoin : toujours, puisque la carte
  // montre le badge. Les adresses sont celles des fournisseurs, publiques on-chain.
  const providers = [...new Set(online.map((row) => row.provider))];
  const [stats, fees, kyb] = await Promise.all([
    loanStatsFor(deps.db, ids),
    computeFeesFor(deps.db, deps.billingMode(), now),
    kybFor(deps, providers),
  ]);

  const candidates: ListingCandidate[] = online.map((row) => {
    const listing = toPublicListing(row, stats.get(row.id) ?? EMPTY_LOAN_STATS, kyb.get(row.provider) ?? null, feeForRow(row, fees));
    const published = row.listedAt ?? row.createdAt;
    return {
      listing,
      text: searchableText(row),
      publishedAt: published instanceof Date && Number.isFinite(published.getTime()) ? published.getTime() : 0,
    };
  });
  const sorted = filterAndSortListings(candidates, query);
  return {
    ...paginate(sorted, query.page),
    truncated,
    token: deps.token,
    computeFees: fees,
    kybAvailable: kybAvailable(kyb, providers),
  };
}

export interface DetailResponse {
  dataset: PublicDetail;
  token: TokenInfo;
  kybAvailable: boolean;
}

/** Fiche d'un dataset en ligne ; `null` pour tout autre état (pause, expiré, détruit, privé, inconnu). */
export async function loadListingDetail(id: string, deps: MarketplaceDeps): Promise<DetailResponse | null> {
  const now = deps.now();
  const row = await deps.db.dataset.findFirst({
    where: { ...onlineDatasetWhere(now), id },
    select: MARKETPLACE_DATASET_SELECT,
  });
  if (!row || row.id !== id || !isOnlineDataset(row, now)) return null;
  const [stats, fees, kyb] = await Promise.all([
    loanStatsFor(deps.db, [row.id]),
    computeFeesFor(deps.db, deps.billingMode(), now),
    kybFor(deps, [row.provider]),
  ]);
  return {
    dataset: toPublicDetail(row, stats.get(row.id) ?? EMPTY_LOAN_STATS, kyb.get(row.provider) ?? null, feeForRow(row, fees)),
    token: deps.token,
    kybAvailable: kybAvailable(kyb, [row.provider]),
  };
}
