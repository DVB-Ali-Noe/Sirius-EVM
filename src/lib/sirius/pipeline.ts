import "server-only";
import { prisma, serializableTransaction } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import { datasetIngressKeyInRunner, sealDatasetInRunner } from "@/lib/tee/runner-client";
import type { DatasetIngressEnvelope } from "@/lib/tee/contract";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { requireAcceptedKyb } from "@/lib/sirius/access";
import { requireRunnerOrWake } from "@/lib/sirius/availability";
import { unpinFromIpfs } from "@/lib/ipfs/pinata";
import { modelSelection, type ModelSelection } from "@/lib/models/registry";
import { assertCurrentRunner, currentRunnerProvenance, type RunnerProvenance } from "@/lib/runner/provenance";

const DATASET_WINDOW_MS = 60 * 60_000;
const ABANDONED_DRAFT_TTL_MS = 30 * 60_000;
const MAX_OPEN_DRAFTS_PER_PROVIDER = 5;
const MAX_DATASETS_PER_PROVIDER_WINDOW = 10;
const MAX_DATASETS_GLOBAL_WINDOW = 200;

export interface IngestInput {
  name: string;
  description?: string;
  provider: string;
  sizeBytes: number;
  priceUsdcAtomic: string;
  challengeDays: number;
  /** Durée maximale de location choisie par le fournisseur (1–365 jours), signée dans le reçu. */
  maxRentalDays: number;
  model: ModelSelection;
}

export interface AuthorizedDatasetUpload extends RunnerProvenance {
  id: string;
  provider: string;
  sizeBytes: number;
  priceUsdcAtomic: string;
  challengeDays: number;
  maxRentalDays: number;
  model: ModelSelection;
}

/** Brouillons vides abandonnés d'un fournisseur : supprimés à la création suivante, jamais comptés. */
function abandonedDrafts(provider: string, now: number): Prisma.DatasetWhereInput {
  return {
    provider, status: "DRAFT", ipfsCid: null, wrappedKey: null, runnerReceipt: null,
    updatedAt: { lte: new Date(now - ABANDONED_DRAFT_TTL_MS) },
  };
}

/**
 * Quotas de création, lus sans écrire : appelés avant le réveil de la CVM (un fournisseur au quota
 * ne la réveille pas), puis de nouveau dans la transaction qui crée le brouillon, où ils font foi.
 */
async function assertIngestionQuota(
  db: { dataset: { count(args: { where: Prisma.DatasetWhereInput }): Promise<number> } },
  provider: string,
  now: number,
) {
  const since = new Date(now - DATASET_WINDOW_MS);
  const abandoned = abandonedDrafts(provider, now);
  const [drafts, providerRecent, globalRecent, stale, staleRecent] = await Promise.all([
    db.dataset.count({ where: { provider, status: "DRAFT" } }),
    db.dataset.count({ where: { provider, createdAt: { gte: since } } }),
    db.dataset.count({ where: { createdAt: { gte: since } } }),
    db.dataset.count({ where: abandoned }),
    db.dataset.count({ where: { ...abandoned, createdAt: { gte: since } } }),
  ]);
  if (drafts - stale >= MAX_OPEN_DRAFTS_PER_PROVIDER) {
    throw new AppError("Trop de datasets en attente d’upload", 429);
  }
  if (providerRecent - staleRecent >= MAX_DATASETS_PER_PROVIDER_WINDOW || globalRecent - staleRecent >= MAX_DATASETS_GLOBAL_WINDOW) {
    throw new AppError("Quota d’ingestion atteint — réessaie plus tard", 429);
  }
}

/**
 * Crée l'identité stable du dataset et fournit la clé d'ingestion publique du runner.
 * Le navigateur chiffre ensuite le fichier pour cette clé avant tout transit par Next.
 */
export async function beginDatasetIngestion({
  name,
  description,
  provider,
  sizeBytes,
  priceUsdcAtomic,
  challengeDays,
  maxRentalDays,
  model,
}: IngestInput) {
  await requireAcceptedKyb(provider);
  await assertIngestionQuota(prisma, provider, Date.now());
  // Fournisseur authentifié, requête validée, KYB accepté, quotas libres : CVM éteinte ⇒ réveil
  // demandé (budget du compte) et 503 `enclave_starting` avant toute écriture ; le navigateur relance.
  await requireRunnerOrWake({ wakeSubject: provider });
  const runner = await currentRunnerProvenance();
  const dataset = await serializableTransaction(async (tx) => {
    const now = Date.now();
    await tx.dataset.deleteMany({ where: abandonedDrafts(provider, now) });
    await assertIngestionQuota(tx, provider, now);
    return tx.dataset.create({
      data: {
        name,
        description,
        provider,
        sizeBytes,
        priceUsdcAtomic,
        challengeDays,
        maxRentalDays,
        modelId: model.modelId,
        modelVersion: model.modelVersion,
        ...runner,
      },
    });
  });
  try {
    const ingressKey = await datasetIngressKeyInRunner();
    return {
      datasetId: dataset.id,
      ingressKey,
      priceUsdcAtomic: dataset.priceUsdcAtomic!,
      challengeDays: dataset.challengeDays,
      maxRentalDays: dataset.maxRentalDays,
      sizeBytes: dataset.sizeBytes,
      model,
    };
  } catch (error) {
    await prisma.dataset.deleteMany({ where: { id: dataset.id, status: "DRAFT", ipfsCid: null } });
    throw error;
  }
}

/** Termes du brouillon relus avant le réveil, pour les contrôles propres à chaque route. */
export type DatasetUploadTerms = Omit<AuthorizedDatasetUpload, keyof RunnerProvenance>;

/**
 * Transmet uniquement l'enveloppe chiffrée au runner. Le CSV est ouvert dans la CVM, puis
 * immédiatement rescellé sous une DEK aléatoire avant son envoi vers IPFS.
 *
 * `validate` : contrôles sans écriture de la route appelante (corps, taille, manifeste, morceaux
 * reçus), exécutés après ceux du brouillon et avant le réveil : une requête invalide ne réveille rien.
 */
export async function authorizeDatasetUpload(
  datasetId: string,
  provider: string,
  validate?: (terms: DatasetUploadTerms) => Promise<void> | void,
): Promise<AuthorizedDatasetUpload> {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    select: {
      provider: true,
      status: true,
      sizeBytes: true,
      priceUsdcAtomic: true,
      challengeDays: true,
      maxRentalDays: true,
      modelId: true,
      modelVersion: true,
      ipfsCid: true,
      wrappedKey: true,
      keyDestroyedAt: true,
      runnerKind: true,
      runnerDeploymentId: true,
    },
  });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  const model = modelSelection(dataset.modelId, dataset.modelVersion);
  if (!model) throw new AppError("Profil d’entraînement du dataset absent ou invalide", 409);
  if (dataset.provider !== provider) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
  if (
    dataset.status !== "DRAFT" ||
    dataset.ipfsCid ||
    dataset.wrappedKey ||
    dataset.keyDestroyedAt ||
    !dataset.sizeBytes ||
    !dataset.priceUsdcAtomic
  ) {
    throw new AppError("Ce dataset ne peut plus recevoir de fichier", 409);
  }
  await requireAcceptedKyb(provider);
  const terms: DatasetUploadTerms = {
    id: datasetId,
    provider,
    sizeBytes: dataset.sizeBytes,
    priceUsdcAtomic: dataset.priceUsdcAtomic,
    challengeDays: dataset.challengeDays,
    maxRentalDays: dataset.maxRentalDays,
    model,
  };
  await validate?.(terms);
  // Scellement ou envoi en morceaux du brouillon de ce fournisseur : même réveil (budget du compte),
  // avant de le toucher.
  await requireRunnerOrWake({ wakeSubject: provider });
  const runner = await assertCurrentRunner(dataset);
  const claimed = await prisma.dataset.updateMany({
    where: {
      id: datasetId,
      provider,
      status: "DRAFT",
      ipfsCid: null,
      wrappedKey: null,
      keyDestroyedAt: null,
    },
    data: { updatedAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError("Upload déjà finalisé ou supprimé", 409);
  return { ...terms, ...runner };
}

export async function completeDatasetIngestion(
  dataset: AuthorizedDatasetUpload,
  envelope: DatasetIngressEnvelope,
  authorization: RunnerGrant,
) {
  await assertCurrentRunner(dataset);
  let sealed;
  try {
    sealed = await sealDatasetInRunner(
      dataset.id,
      dataset.priceUsdcAtomic,
      dataset.challengeDays,
      dataset.sizeBytes,
      envelope,
      authorization,
      dataset.model,
      dataset.maxRentalDays,
    );
  } catch (error) {
    // Un refus du runner (fichier invalide, quota de démonstration, session fermée, grant
    // refusé) laissait un brouillon vide, inutilisable : chaque nouvelle tentative du
    // navigateur crée son propre brouillon. On le supprime à la place du fournisseur, sinon
    // cinq refus bloquent ses dépôts suivants (« Trop de datasets en attente d’upload »).
    //
    // Uniquement sur un refus (4xx). Sur une panne passagère du runner (5xx), le brouillon
    // reste ; le nettoyage différé de `beginDatasetIngestion` s'en charge.
    if (error instanceof AppError && error.status >= 400 && error.status < 500) {
      await prisma.dataset
        .deleteMany({
          where: {
            id: dataset.id,
            provider: dataset.provider,
            status: "DRAFT",
            ipfsCid: null,
            wrappedKey: null,
            evmDatasetId: null,
          },
        })
        .catch(() => console.error(`Nettoyage du brouillon refusé impossible pour ${dataset.id}`));
    }
    throw error;
  }
  const { cid, wrappedKey, merkleRoot, metrics, sizeBytes, runnerReceipt } = sealed;
  try {
    if (sizeBytes !== dataset.sizeBytes) {
      throw new AppError("La taille du fichier ne correspond pas au dépôt", 400);
    }

    const claimed = await prisma.dataset.updateMany({
      where: {
        id: dataset.id,
        provider: dataset.provider,
        status: "DRAFT",
        ipfsCid: null,
        wrappedKey: null,
        keyDestroyedAt: null,
      },
      data: {
        ipfsCid: cid,
        wrappedKey,
        merkleRoot,
        metrics: metrics as unknown as Prisma.InputJsonValue,
        runnerReceipt,
        runnerKind: dataset.runnerKind,
        runnerDeploymentId: dataset.runnerDeploymentId,
      },
    });
    if (claimed.count !== 1) throw new AppError("Le dataset a changé pendant le scellement", 409);
    return prisma.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
  } catch (error) {
    await unpinFromIpfs(cid).catch(() =>
      console.error(`Unpin IPFS compensatoire échoué pour ${dataset.id}`),
    );
    throw error;
  }
}
