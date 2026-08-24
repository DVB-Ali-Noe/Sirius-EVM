import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import { datasetIngressKeyInRunner, sealDatasetInRunner } from "@/lib/tee/runner-client";
import type { DatasetIngressEnvelope } from "@/lib/tee/contract";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
import { requireAcceptedKyb } from "@/lib/sirius/access";
import { unpinFromIpfs } from "@/lib/ipfs/pinata";

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
  priceDrops: string;
  challengeDays: number;
}

export interface AuthorizedDatasetUpload {
  id: string;
  provider: string;
  sizeBytes: number;
  priceDrops: string;
  challengeDays: number;
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
  priceDrops,
  challengeDays,
}: IngestInput) {
  await requireAcceptedKyb(provider);
  const dataset = await prisma.$transaction(async (tx) => {
    const now = Date.now();
    const since = new Date(now - DATASET_WINDOW_MS);
    await tx.dataset.deleteMany({
      where: {
        provider,
        status: "DRAFT",
        ipfsCid: null,
        wrappedKey: null,
        runnerReceipt: null,
        updatedAt: { lte: new Date(now - ABANDONED_DRAFT_TTL_MS) },
      },
    });
    const [drafts, providerRecent, globalRecent] = await Promise.all([
      tx.dataset.count({ where: { provider, status: "DRAFT" } }),
      tx.dataset.count({ where: { provider, createdAt: { gte: since } } }),
      tx.dataset.count({ where: { createdAt: { gte: since } } }),
    ]);
    if (drafts >= MAX_OPEN_DRAFTS_PER_PROVIDER) {
      throw new AppError("Trop de datasets en attente d’upload", 429);
    }
    if (providerRecent >= MAX_DATASETS_PER_PROVIDER_WINDOW || globalRecent >= MAX_DATASETS_GLOBAL_WINDOW) {
      throw new AppError("Quota d’ingestion atteint — réessaie plus tard", 429);
    }
    return tx.dataset.create({
      data: { name, description, provider, sizeBytes, priceDrops, challengeDays },
    });
  });
  try {
    const ingressKey = await datasetIngressKeyInRunner();
    return {
      datasetId: dataset.id,
      ingressKey,
      priceDrops: dataset.priceDrops,
      challengeDays: dataset.challengeDays,
      sizeBytes: dataset.sizeBytes,
    };
  } catch (error) {
    await prisma.dataset.deleteMany({ where: { id: dataset.id, status: "DRAFT", ipfsCid: null } });
    throw error;
  }
}

/**
 * Transmet uniquement l'enveloppe chiffrée au runner. Le CSV est ouvert dans la CVM, puis
 * immédiatement rescellé sous une DEK aléatoire avant son envoi vers IPFS.
 */
export async function authorizeDatasetUpload(
  datasetId: string,
  provider: string,
): Promise<AuthorizedDatasetUpload> {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    select: {
      provider: true,
      status: true,
      sizeBytes: true,
      priceDrops: true,
      challengeDays: true,
      ipfsCid: true,
      wrappedKey: true,
      keyDestroyedAt: true,
    },
  });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (dataset.provider !== provider) throw new AppError("Accès refusé : ressource d’un autre compte", 403);
  if (
    dataset.status !== "DRAFT" ||
    dataset.ipfsCid ||
    dataset.wrappedKey ||
    dataset.keyDestroyedAt ||
    !dataset.sizeBytes
  ) {
    throw new AppError("Ce dataset ne peut plus recevoir de fichier", 409);
  }
  await requireAcceptedKyb(provider);
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
  return {
    id: datasetId,
    provider,
    sizeBytes: dataset.sizeBytes,
    priceDrops: dataset.priceDrops,
    challengeDays: dataset.challengeDays,
  };
}

export async function completeDatasetIngestion(
  dataset: AuthorizedDatasetUpload,
  envelope: DatasetIngressEnvelope,
  authorization: RunnerGrant,
) {
  const { cid, wrappedKey, merkleRoot, metrics, sizeBytes, runnerReceipt } = await sealDatasetInRunner(
    dataset.id,
    dataset.priceDrops,
    dataset.challengeDays,
    dataset.sizeBytes,
    envelope,
    authorization,
  );
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
      },
    });
    if (claimed.count !== 1) throw new AppError("Le dataset a changé pendant le scellement", 409);
    return prisma.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
  } catch (error) {
    await unpinFromIpfs(cid).catch((unpinError) =>
      console.error(`Unpin IPFS compensatoire échoué pour ${dataset.id}`, unpinError),
    );
    throw error;
  }
}
