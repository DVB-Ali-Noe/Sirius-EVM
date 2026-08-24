import "server-only";
import type { Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { DatasetStatus } from "@/generated/prisma/client";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { datasetRegistryAddress } from "@/lib/evm/addresses";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { cidHash, datasetIdHash } from "@/lib/evm/dataset-key";
import { destroyDatasetTransaction, mintDatasetTransaction } from "@/lib/evm/transaction";
import { unpinFromIpfs } from "@/lib/ipfs/pinata";
import { requireAcceptedKyb } from "./access";

export const VISIBILITY_STATES = ["LISTED", "UNLISTED", "PRIVATE"] as const;
export type Visibility = (typeof VISIBILITY_STATES)[number];
export const BORROWABLE_STATUSES = ["LISTED", "UNLISTED"] satisfies readonly DatasetStatus[];

export function isBorrowableDatasetStatus(status: DatasetStatus): boolean {
  return (BORROWABLE_STATUSES as readonly DatasetStatus[]).includes(status);
}

async function ownedDataset(datasetId: string, provider: string) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (!addressesEqual(dataset.provider, provider)) throw new AppError("Wallet ≠ provider du dataset", 403);
  return dataset;
}

function listingTerms(dataset: Awaited<ReturnType<typeof ownedDataset>>) {
  if (!dataset.ipfsCid || !dataset.merkleRoot || !dataset.wrappedKey || !dataset.runnerReceipt || !dataset.sizeBytes) {
    throw new AppError("Dataset incomplet ou reçu runner absent", 409);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(dataset.merkleRoot)) {
    throw new AppError("Racine Merkle EVM invalide", 409);
  }
  return {
    datasetId: dataset.id,
    cid: dataset.ipfsCid,
    merkleRoot: dataset.merkleRoot as Hex,
    sizeBytes: dataset.sizeBytes,
  };
}

export async function prepareDatasetListing(datasetId: string, provider: string) {
  const dataset = await ownedDataset(datasetId, provider);
  if (dataset.status === "LISTED" && dataset.evmDatasetId) throw new AppError("Dataset déjà publié", 409);
  if (dataset.status !== "DRAFT") throw new AppError("Seul un dataset DRAFT rescellé peut être publié", 409);
  await requireAcceptedKyb(provider);
  return mintDatasetTransaction(listingTerms(dataset));
}

export async function finalizeDatasetListing(datasetId: string, provider: string, txHash?: string) {
  const dataset = await ownedDataset(datasetId, provider);
  if (dataset.status === "LISTED" && dataset.evmDatasetId) return dataset;
  if (dataset.status !== "DRAFT") throw new AppError("Seul un dataset DRAFT rescellé peut être publié", 409);
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AppError("Hash de mint EVM manquant", 400);
  await requireAcceptedKyb(provider);
  const terms = listingTerms(dataset);
  const registry = datasetRegistryAddress();
  const publicClient = getPublicClient();
  const [receipt, transaction, onChainId] = await Promise.all([
    publicClient.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 }),
    publicClient.getTransaction({ hash: txHash as Hex }),
    publicClient.readContract({
      address: registry,
      abi: siriusdatasetregistryAbi,
      functionName: "datasetIdOf",
      args: [normalizeAddress(provider), datasetIdHash(datasetId)],
    }),
  ]);
  if (receipt.status !== "success" || !addressesEqual(transaction.from, provider) || !addressesEqual(transaction.to ?? "", registry)) {
    throw new AppError("Transaction de titre EVM invalide", 409);
  }
  const matchesScope = await publicClient.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "matchesScope",
    args: [onChainId, normalizeAddress(provider), terms.merkleRoot, cidHash(terms.cid)],
  });
  if (!matchesScope) {
    throw new AppError("Titre EVM hors scope du dataset", 409);
  }
  const updated = await prisma.dataset.updateMany({
    where: { id: datasetId, provider: normalizeAddress(provider), status: "DRAFT", evmDatasetId: null },
    data: {
      status: "LISTED",
      evmDatasetId: onChainId,
      evmMintTxHash: txHash,
      evmMintBlock: receipt.blockNumber.toString(),
    },
  });
  if (updated.count !== 1) throw new AppError("Publication EVM concurrente", 409);
  return prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
}

export async function prepareDatasetDestruction(datasetId: string, provider: string) {
  const dataset = await ownedDataset(datasetId, provider);
  if (dataset.status === "DELETED") return null;
  if (dataset.status === "DRAFT") return null;
  if (!dataset.evmDatasetId) throw new AppError("Titre EVM absent", 409);
  return destroyDatasetTransaction(datasetId);
}

export async function deleteDataset(datasetId: string, provider: string, txHash?: string) {
  const dataset = await ownedDataset(datasetId, provider);
  if (dataset.status === "DELETED") return dataset;
  if (dataset.status !== "DRAFT") {
    if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AppError("Hash de tombstone EVM manquant", 400);
    const registry = datasetRegistryAddress();
    const publicClient = getPublicClient();
    const [receipt, transaction] = await Promise.all([
      publicClient.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 }),
      publicClient.getTransaction({ hash: txHash as Hex }),
    ]);
    if (receipt.status !== "success" || !addressesEqual(transaction.from, provider) || !addressesEqual(transaction.to ?? "", registry)) {
      throw new AppError("Transaction de tombstone EVM invalide", 409);
    }
    const datasetIdOnChain = dataset.evmDatasetId as Hex;
    const live = await publicClient.readContract({
      address: registry,
      abi: siriusdatasetregistryAbi,
      functionName: "isLive",
      args: [datasetIdOnChain],
    });
    if (live) throw new AppError("Tombstone EVM non confirmé", 409);
  }

  const deleted = await prisma.dataset.updateMany({
    where: {
      id: datasetId,
      provider: normalizeAddress(provider),
      status: { not: "DELETED" },
      loans: { none: { status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } } },
    },
    data: {
      wrappedKey: null,
      status: "DELETED",
      keyDestroyedAt: new Date(),
      ...(txHash ? { evmDestroyTxHash: txHash } : {}),
    },
  });
  if (deleted.count !== 1) throw new AppError("Suppression impossible : emprunt actif ou état modifié", 409);
  if (dataset.ipfsCid) {
    await unpinFromIpfs(dataset.ipfsCid).catch((error) => console.error(`[dataset] unpin ${datasetId} échoué`, error));
  }
  return prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
}

export async function setDatasetVisibility(datasetId: string, provider: string, visibility: Visibility) {
  if (!VISIBILITY_STATES.includes(visibility)) throw new AppError("Visibilité invalide", 400);
  const updated = await prisma.dataset.updateMany({
    where: { id: datasetId, provider: normalizeAddress(provider), status: { in: [...VISIBILITY_STATES] } },
    data: { status: visibility },
  });
  if (updated.count !== 1) throw new AppError("Visibilité modifiable uniquement pour un dataset publié", 409);
  return prisma.dataset.findUniqueOrThrow({ where: { id: datasetId } });
}
