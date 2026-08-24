import "server-only";
import {
  decode,
  hashes,
  type MPTokenIssuanceCreate,
  type MPTokenIssuanceDestroy,
  type Wallet,
} from "xrpl";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { getServerWallet } from "@/lib/xrpl/server-wallets";
import { hasAcceptedKyb, KYB_TYPE_HEX } from "@/lib/xrpl/credentials";
import { setPermissionedDomain } from "@/lib/xrpl/domains";
import { getClient } from "@/lib/xrpl/client";
import { reconcileTransaction } from "@/lib/xrpl/tx";
import {
  assertDatasetMptCreateScope,
  assertDatasetMptDestroyScope,
  buildDatasetMpt,
  buildDatasetMptDestroy,
  reconcileDatasetMpt,
  submitSignedDatasetMptDestroy,
  submitPreparedDatasetMpt,
  type PreparedDatasetMpt,
} from "@/lib/xrpl/mpt";
import { unpinFromIpfs } from "@/lib/ipfs/pinata";
import type { DatasetStatus } from "@/generated/prisma/client";
import { siriusVerifierAddress } from "@/lib/xrpl/verifier";

/** Visibilités réglables par le provider (labels UI : Public / Semi-privé / Privé). */
export const VISIBILITY_STATES = ["LISTED", "UNLISTED", "PRIVATE"] as const;
export type Visibility = (typeof VISIBILITY_STATES)[number];

/** Statuts sous lesquels un dataset est empruntable par un tiers (Public + Semi-privé). */
export const BORROWABLE_STATUSES = ["LISTED", "UNLISTED"] satisfies readonly DatasetStatus[];
export function isBorrowableDatasetStatus(status: DatasetStatus): boolean {
  return (BORROWABLE_STATUSES as readonly DatasetStatus[]).includes(status);
}

/** Autorité Sirius : émet les KYB et possède le Permissioned Domain. */
export function getSiriusWallet(): Wallet {
  return getServerWallet("verifier");
}

/** Setup admin : Permissioned Domain Sirius acceptant le credType KYB. Renvoie le DomainID. */
export async function ensureSiriusDomain(domainId?: string): Promise<string> {
  const sirius = getSiriusWallet();
  return setPermissionedDomain(
    sirius,
    [{ issuer: sirius.address, credentialType: KYB_TYPE_HEX }],
    domainId,
  );
}

type DatasetForMpt = Awaited<ReturnType<typeof datasetForMpt>>;

async function datasetForMpt(datasetId: string, providerAddress: string) {
  const dataset = await prisma.dataset.findUnique({
    where: { id: datasetId },
    omit: { wrappedKey: false, mptTxHash: false, mptTxBlob: false, mptLastLedger: false },
  });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (dataset.provider !== providerAddress) throw new AppError("Wallet ≠ provider du dataset", 403);
  return dataset;
}

function mptMetadata(dataset: NonNullable<DatasetForMpt>) {
  if (!dataset.ipfsCid || !dataset.merkleRoot || !dataset.wrappedKey || !dataset.runnerReceipt) {
    throw new AppError("Dataset incomplet ou reçu runner absent", 409);
  }
  return {
    datasetId: dataset.id,
    name: dataset.name,
    ipfsCid: dataset.ipfsCid,
    merkleRoot: dataset.merkleRoot,
    sizeBytes: dataset.sizeBytes ?? 0,
  };
}

/**
 * Prépare la publication d'un dataset DRAFT : gating KYB puis mint MPT client.
 * Le provider détient son MPT (non-custodial).
 */
export async function prepareDatasetListing(datasetId: string, providerAddress: string) {
  const dataset = await datasetForMpt(datasetId, providerAddress);
  const metadata = mptMetadata(dataset);
  if (dataset.status === "LISTED" && dataset.mptIssuanceId) {
    throw new AppError("Dataset déjà publié", 409);
  }
  if (dataset.status === "LISTING") {
    throw new AppError("Publication MPT déjà signée — réconcilie-la", 409);
  }
  if (dataset.status !== "DRAFT") {
    throw new AppError("Seul un dataset DRAFT rescellé peut être publié", 409);
  }
  if (dataset.mptIssuanceId) throw new AppError("Dataset déjà lié à un MPT", 409);
  if (!(await hasAcceptedKyb(providerAddress, siriusVerifierAddress()))) {
    throw new AppError("KYB requis : aucun credential KYB accepté pour ce provider", 403);
  }
  return buildDatasetMpt(providerAddress, metadata);
}

export async function finalizeDatasetListing(
  datasetId: string,
  providerAddress: string,
  submittedBlob?: string,
) {
  const dataset = await datasetForMpt(datasetId, providerAddress);
  const metadata = mptMetadata(dataset);
  if (dataset.status === "LISTED" && dataset.mptIssuanceId) {
    return prisma.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
  }
  if (dataset.status !== "DRAFT" && dataset.status !== "LISTING") {
    throw new AppError("Seul un dataset DRAFT rescellé peut être publié", 409);
  }
  if (dataset.mptIssuanceId) throw new AppError("Dataset déjà lié à un MPT", 409);
  if (!(await hasAcceptedKyb(providerAddress, siriusVerifierAddress()))) {
    throw new AppError("KYB requis : aucun credential KYB accepté pour ce provider", 403);
  }

  let prepared: PreparedDatasetMpt;
  if (dataset.status === "LISTING") {
    if (!dataset.mptTxBlob || !dataset.mptTxHash || dataset.mptLastLedger == null) {
      await prisma.dataset.updateMany({
        where: { id: dataset.id, status: "LISTING", mptTxHash: null, mptTxBlob: null },
        data: { status: "DRAFT" },
      });
      throw new AppError("Publication MPT interrompue avant signature — relance-la", 409);
    }
    if (submittedBlob && submittedBlob !== dataset.mptTxBlob) {
      throw new AppError("Une autre publication MPT est déjà en réconciliation", 409);
    }
    prepared = {
      txBlob: dataset.mptTxBlob,
      txHash: dataset.mptTxHash,
      lastLedgerSequence: dataset.mptLastLedger,
    };
  } else {
    if (!submittedBlob) throw new AppError("Transaction MPT signée manquante", 400);
    let transaction: MPTokenIssuanceCreate;
    try {
      transaction = decode(submittedBlob) as MPTokenIssuanceCreate;
    } catch {
      throw new AppError("Transaction MPT signée illisible", 400);
    }
    assertDatasetMptCreateScope(transaction, providerAddress, metadata);
    prepared = {
      txBlob: submittedBlob,
      txHash: hashes.hashSignedTx(submittedBlob),
      lastLedgerSequence: transaction.LastLedgerSequence as number,
    };
    const claim = await prisma.dataset.updateMany({
      where: {
        id: dataset.id,
        status: "DRAFT",
        mptIssuanceId: null,
        wrappedKey: { not: null },
        runnerReceipt: { not: null },
      },
      data: {
        status: "LISTING",
        mptTxBlob: prepared.txBlob,
        mptTxHash: prepared.txHash,
        mptLastLedger: prepared.lastLedgerSequence,
      },
    });
    if (claim.count !== 1) throw new AppError("Publication MPT déjà en cours", 409);
  }

  let mptIssuanceId: string;
  try {
    mptIssuanceId = await submitPreparedDatasetMpt(prepared);
  } catch (error) {
    const reconciliation = await reconcileDatasetMpt(
      prepared.txHash,
      prepared.lastLedgerSequence,
    );
    if (reconciliation.state === "confirmed") {
      mptIssuanceId = reconciliation.issuanceId;
    } else if (reconciliation.state === "failed") {
      await prisma.dataset.updateMany({
        where: { id: dataset.id, status: "LISTING", mptTxHash: prepared.txHash },
        data: { status: "DRAFT", mptTxBlob: null, mptTxHash: null, mptLastLedger: null },
      });
      throw error;
    } else {
      throw new AppError("Publication MPT soumise mais pas encore réconciliée", 503);
    }
  }

  const published = await prisma.dataset.updateMany({
    where: { id: dataset.id, status: "LISTING", mptTxHash: prepared.txHash, mptIssuanceId: null },
    data: {
      mptIssuanceId,
      status: "LISTED",
      mptTxBlob: null,
      mptLastLedger: null,
    },
  });
  if (published.count !== 1) throw new AppError("Publication MPT non réconciliée", 409);
  return prisma.dataset.findUniqueOrThrow({ where: { id: dataset.id } });
}

export async function prepareDatasetMptDestruction(datasetId: string, providerAddress: string) {
  const dataset = await datasetForMpt(datasetId, providerAddress);
  if (dataset.status === "LISTING") throw new AppError("Suppression impossible pendant le mint MPT", 409);
  if (dataset.mptDestroyedAt || (dataset.status === "DELETED" && dataset.mptTxBlob)) return null;
  return dataset.mptIssuanceId
    ? buildDatasetMptDestroy(providerAddress, dataset.mptIssuanceId)
    : null;
}

export async function deleteDataset(
  datasetId: string,
  providerAddress: string,
  mptDestroyTxBlob?: string,
) {
  const before = await datasetForMpt(datasetId, providerAddress);
  const txBlob = mptDestroyTxBlob ?? (before.status === "DELETED" ? before.mptTxBlob ?? undefined : undefined);
  let prepared: PreparedDatasetMpt | undefined;
  if (before.mptIssuanceId && !before.mptDestroyedAt) {
    if (!txBlob) throw new AppError("Signature de destruction MPT requise", 400);
    let transaction: MPTokenIssuanceDestroy;
    try {
      transaction = decode(txBlob) as MPTokenIssuanceDestroy;
    } catch {
      throw new AppError("Transaction de destruction MPT illisible", 400);
    }
    assertDatasetMptDestroyScope(transaction, providerAddress, before.mptIssuanceId);
    prepared = {
      txBlob,
      txHash: hashes.hashSignedTx(txBlob),
      lastLedgerSequence: transaction.LastLedgerSequence as number,
    };
    if (
      before.status === "DELETED" &&
      (before.mptTxBlob !== prepared.txBlob ||
        before.mptTxHash !== prepared.txHash ||
        before.mptLastLedger !== prepared.lastLedgerSequence)
    ) {
      throw new AppError("Une autre destruction MPT est déjà en réconciliation", 409);
    }
  }

  const deleted = await shredDataset(datasetId, providerAddress, prepared);
  if (prepared) {
    const claimed = await datasetForMpt(datasetId, providerAddress);
    if (
      claimed.mptTxBlob !== prepared.txBlob ||
      claimed.mptTxHash !== prepared.txHash ||
      claimed.mptLastLedger !== prepared.lastLedgerSequence
    ) {
      throw new AppError("Une autre destruction MPT est déjà en réconciliation", 409);
    }
    let txHash: string;
    try {
      txHash = await submitSignedDatasetMptDestroy(prepared.txBlob);
    } catch {
      const reconciliation = await reconcileTransaction(
        await getClient(),
        prepared.txHash,
        prepared.lastLedgerSequence,
      );
      if (reconciliation === "pending") {
        throw new AppError("Données supprimées, destruction MPT en attente", 503);
      }
      if (reconciliation === "failed") {
        await prisma.dataset.updateMany({
          where: { id: datasetId, status: "DELETED", mptTxHash: prepared.txHash },
          data: { mptTxHash: null, mptTxBlob: null, mptLastLedger: null },
        });
        throw new AppError("Données supprimées, destruction MPT à signer de nouveau", 409);
      }
      txHash = prepared.txHash;
    }
    if (txHash !== prepared.txHash) throw new AppError("Hash de destruction MPT incohérent", 502);
    const confirmed = await prisma.dataset.updateMany({
      where: { id: datasetId, status: "DELETED", mptTxHash: prepared.txHash },
      data: { mptTxBlob: null, mptLastLedger: null, mptDestroyedAt: new Date() },
    });
    if (confirmed.count !== 1) {
      throw new AppError("Destruction MPT confirmée mais état local incohérent", 409);
    }
  }
  return deleted;
}

/**
 * Suppression par crypto-shredding (D-21) : détruit la DEK du dataset (data
 * irrécupérable même si un chunk IPFS survit) et dépinne le CID.
 * Bloqué tant qu'un emprunt est actif (ESCROWED/TRAINING) pour ne pas casser un
 * accès en cours. L'unpin est best-effort ; seul l'effacement de la clé est garanti.
 * La destruction MPT signée par le provider est orchestrée séparément.
 */
export async function shredDataset(
  datasetId: string,
  providerAddress: string,
  mptDestruction?: PreparedDatasetMpt,
) {
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (dataset.provider !== providerAddress) throw new AppError("Wallet ≠ provider du dataset", 403);
  if (dataset.status === "DELETED") return dataset; // idempotent
  if (dataset.status === "LISTING") throw new AppError("Suppression impossible pendant le mint MPT", 409);

  // Claim atomique (symétrie borrower.ts/settle.ts) : un seul appel concurrent gagne
  // l'effacement — et donc les effets de bord on-chain. Acte irréversible garanti ici
  // même (la DEK n'a aucune autre copie → data irrécupérable), avant tout appel réseau.
  const claim = await prisma.dataset.updateMany({
    where: {
      id: datasetId,
      status: { notIn: ["DELETED", "LISTING"] },
      loans: { none: { status: { in: ["PENDING", "SUBMITTING", "ESCROWED", "TRAINING", "SETTLING"] } } },
    },
    data: {
      wrappedKey: null,
      status: "DELETED",
      keyDestroyedAt: new Date(),
      ...(mptDestruction && {
        mptTxHash: mptDestruction.txHash,
        mptTxBlob: mptDestruction.txBlob,
        mptLastLedger: mptDestruction.lastLedgerSequence,
      }),
    },
  });

  if (claim.count === 0) {
    const current = await prisma.dataset.findUnique({ where: { id: datasetId } });
    if (current?.status === "DELETED") return current;
    throw new AppError("Suppression impossible : un emprunt est réservé ou en cours", 409);
  }

  // Best-effort réservé au gagnant du claim, après l'effacement (data déjà irrécupérable).
  if (dataset.ipfsCid) {
    await unpinFromIpfs(dataset.ipfsCid).catch((err) =>
      console.error(`Unpin IPFS échoué pour ${datasetId} (best-effort)`, err),
    );
  }
  const result = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!result) throw new AppError("Dataset introuvable", 404);
  return result;
}

/**
 * Change la visibilité d'un dataset déjà publié (Public/Semi-privé/Privé), réversible.
 * Pur changement de statut DB (pas d'action on-chain) → gardé par l'identité du provider.
 * Un dataset DRAFT doit d'abord être publié par le wallet provider ; DELETED/SUSPENDED figés.
 */
export async function setDatasetVisibility(datasetId: string, owner: string, visibility: Visibility) {
  if (!VISIBILITY_STATES.includes(visibility)) throw new AppError("Visibilité invalide", 400);

  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (dataset.provider !== owner) throw new AppError("Wallet ≠ provider du dataset", 403);

  // Claim atomique (symétrie shredDataset) : n'écrit que si le dataset est encore
  // « publié » → un crypto-shredding concurrent ne peut pas être ressuscité
  // (DELETED n'est pas dans VISIBILITY_STATES, donc le claim échoue).
  const claim = await prisma.dataset.updateMany({
    where: { id: datasetId, status: { in: [...VISIBILITY_STATES] } },
    data: { status: visibility },
  });
  if (claim.count === 0) {
    throw new AppError("Visibilité modifiable uniquement pour un dataset publié", 409);
  }

  const result = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!result) throw new AppError("Dataset introuvable", 404);
  return result;
}
