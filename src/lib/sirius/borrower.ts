import "server-only";
import type { Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { datasetRegistryAddress, escrowAddress } from "@/lib/evm/addresses";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { readLoan } from "@/lib/evm/escrow";
import { approveUsdcTransaction, lockUsdcTransaction } from "@/lib/evm/transaction";
import { escrowHashlockInRunner } from "@/lib/tee/runner-client";
import { modelSelection, trainingProfileHash } from "@/lib/models/registry";
import { requireAcceptedKyb, requireCounterpartyKyb } from "./access";
import { BORROWABLE_STATUSES, isBorrowableDatasetStatus } from "./provider";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { recoverUnsubmittedLoan } from "./recover-loan";
import { assertLoanLockTransaction } from "@/lib/evm/history";

const MAX_PENDING_LOANS = 5;
const RATE_WINDOW_MS = 3_600_000;
const MAX_RUNS_PER_WINDOW = 3;

export async function prepareLoan(datasetId: string, borrower: string) {
  const borrowerAddress = normalizeAddress(borrower);
  await requireCurrentEvmDeployment();
  // `wrappedKey` est retirée de toute lecture par le `omit` global de `db.ts`, pour
  // qu'elle ne puisse jamais partir dans une réponse d'API. Les contrôles ci-dessous
  // vérifient qu'elle EXISTE — sur un objet d'où elle vient d'être supprimée, ils
  // échouaient donc systématiquement, et aucun dataset ne pouvait être publié,
  // emprunté ni réglé. On la réinclut ici, comme le prévoit `db.ts` : cet objet ne
  // quitte pas le serveur.
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId }, omit: { wrappedKey: false } });
  if (!dataset) throw new AppError("Dataset introuvable", 404);
  if (!isBorrowableDatasetStatus(dataset.status) || !dataset.evmDatasetId) {
    throw new AppError("Dataset EVM non disponible", 409);
  }
  if (!dataset.priceUsdcAtomic || !dataset.ipfsCid || !dataset.wrappedKey || !dataset.merkleRoot || !dataset.runnerReceipt) {
    throw new AppError("Dataset EVM incomplet", 409);
  }
  const model = modelSelection(dataset.modelId, dataset.modelVersion);
  if (!model) throw new AppError("Profil d’entraînement du dataset absent ou invalide", 409);
  const amountUsdcAtomic = dataset.priceUsdcAtomic;
  if (addressesEqual(dataset.provider, borrowerAddress)) throw new AppError("Un provider ne peut pas emprunter son propre dataset", 400);
  await requireAcceptedKyb(borrowerAddress);
  // Le contrat exige les deux KYB. Sans ce contrôle, l'échec surviendrait après
  // que l'emprunteur a signé et payé l'approbation USDC.
  await requireCounterpartyKyb(dataset.provider, "fournisseur");

  const live = await getPublicClient().readContract({
    address: datasetRegistryAddress(),
    abi: siriusdatasetregistryAbi,
    functionName: "isLive",
    args: [dataset.evmDatasetId as Hex],
  });
  if (!live) throw new AppError("Titre EVM du dataset détruit", 409);

  const loan = await prisma.$transaction(async (tx) => {
    const [pending, recentRuns] = await Promise.all([
      tx.loan.count({ where: { borrower: borrowerAddress, status: { in: ["PENDING", "SUBMITTING"] } } }),
      tx.loan.count({
        where: {
          borrower: borrowerAddress,
          datasetId,
          status: { in: ["ESCROWED", "TRAINING", "SETTLING", "SETTLED"] },
          createdAt: { gte: new Date(Date.now() - RATE_WINDOW_MS) },
        },
      }),
    ]);
    if (pending >= MAX_PENDING_LOANS) throw new AppError("Trop d’emprunts en attente", 429);
    if (recentRuns >= MAX_RUNS_PER_WINDOW) throw new AppError("Trop d’emprunts récents sur ce dataset", 429);
    const available = await tx.dataset.updateMany({
      where: {
        id: datasetId,
        status: { in: [...BORROWABLE_STATUSES] },
        evmDatasetId: { not: null },
        wrappedKey: { not: null },
        runnerReceipt: { not: null },
      },
      data: { updatedAt: new Date() },
    });
    if (available.count !== 1) throw new AppError("Dataset non disponible", 409);
    return tx.loan.create({
      data: {
        datasetId,
        borrower: borrowerAddress,
        provider: dataset.provider,
        amountUsdcAtomic,
        modelId: model.modelId,
        modelVersion: model.modelVersion,
      },
    });
  });

  try {
    const binding = evmEscrowBinding();
    const preparedBlock = await getPublicClient().getBlockNumber();
    const hashlock = await escrowHashlockInRunner(loan.id, borrowerAddress);
    const loanKey = loanKeyFor(borrowerAddress, loan.id);
    const prepared = await prisma.loan.update({
      where: { id: loan.id },
      data: {
        evmLoanKey: loanKey,
        evmHashlock: hashlock,
        evmChainId: binding.chainId,
        evmEscrowAddress: binding.escrow,
        evmPreparedBlock: preparedBlock.toString(),
        evmDeadline: new Date(Date.now() + dataset.challengeDays * 86_400_000),
      },
    });
    return {
      loan: prepared,
      approveTransaction: approveUsdcTransaction(amountUsdcAtomic),
      lockTransaction: lockUsdcTransaction({
        provider: dataset.provider,
        datasetId: dataset.evmDatasetId as Hex,
        amount: amountUsdcAtomic,
        hashlock,
        challengeDays: dataset.challengeDays,
        loanId: loan.id,
        trainingProfile: trainingProfileHash(model),
      }),
    };
  } catch (error) {
    await prisma.loan.deleteMany({ where: { id: loan.id, status: "PENDING" } });
    throw error;
  }
}

export async function finalizeLoan(loanId: string, borrower: string, lockTxHash?: string) {
  const borrowerAddress = normalizeAddress(borrower);
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: { omit: { wrappedKey: false } } } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(loan.borrower, borrowerAddress)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  if (loan.status === "ESCROWED" && loan.evmLockTxHash) return loan;
  const recoverableCancellation = loan.status === "CANCELLED" && !loan.cancelTxHash;
  if (loan.status !== "PENDING" && loan.status !== "SUBMITTING" && !recoverableCancellation) {
    throw new AppError("Emprunt déjà clôturé", 409);
  }
  if (!loan.evmLoanKey || !loan.evmHashlock || !loan.amountUsdcAtomic) throw new AppError("Emprunt EVM non préparé", 409);
  const submittedLockTxHash = lockTxHash ?? loan.evmLockTxHash;
  if (!submittedLockTxHash || !/^0x[0-9a-fA-F]{64}$/.test(submittedLockTxHash)) {
    throw new AppError("Hash de lock USDC manquant", 400);
  }
  const replacingHash = loan.evmLockTxHash && loan.evmLockTxHash.toLowerCase() !== submittedLockTxHash.toLowerCase();
  if (!loan.evmEscrowAddress || loan.evmEscrowAddress !== evmEscrowBinding().escrow || replacingHash) {
    // Reprise d'un ancien lock : l'état et le contrat viennent de la chaîne,
    // sans dépendre du profil du dataset désormais suspendu.
    await recoverUnsubmittedLoan({ ...loan, evmLockTxHash: submittedLockTxHash }, { requireConfirmedLock: true });
    const recovered = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    const confirmed = ["ESCROWED", "TRAINING", "SETTLING", "SETTLED"].includes(recovered.status)
      || (recovered.status === "CANCELLED" && Boolean(recovered.cancelTxHash));
    if (!confirmed
      || recovered.evmLockTxHash?.toLowerCase() !== submittedLockTxHash.toLowerCase()) {
      throw new AppError("Lock USDC non confirmé : actualise son état", 409);
    }
    return recovered;
  }
  await requireCurrentEvmDeployment();
  const submission = await prisma.loan.updateMany({
    where: {
      id: loan.id,
      borrower: borrowerAddress,
      status: { in: ["PENDING", "SUBMITTING", "CANCELLED"] },
      cancelTxHash: null,
      OR: [{ evmLockTxHash: null }, { evmLockTxHash: submittedLockTxHash }],
    },
    data: { status: "SUBMITTING", evmLockTxHash: submittedLockTxHash },
  });
  if (submission.count !== 1) {
    const current = await prisma.loan.findUnique({ where: { id: loan.id } });
    if (current?.status === "ESCROWED" && current.evmLockTxHash?.toLowerCase() === submittedLockTxHash.toLowerCase()) return current;
    throw new AppError("Soumission de lock USDC concurrente", 409);
  }
  if (!loan.dataset.evmDatasetId || !loan.dataset.wrappedKey || !loan.dataset.runnerReceipt) {
    throw new AppError("Dataset indisponible", 409);
  }
  const lockedModel = modelSelection(loan.modelId, loan.modelVersion);
  if (!lockedModel) throw new AppError("Profil d’entraînement du loan invalide", 409);

  const publicClient = getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: submittedLockTxHash as Hex, confirmations: 1 });
  const [transaction, onChain] = await Promise.all([
    publicClient.getTransaction({ hash: submittedLockTxHash as Hex }),
    readLoan(loan.evmLoanKey as Hex),
  ]);
  try {
    if (receipt.status !== "success") throw new AppError("Transaction de lock USDC rejetée", 409);
    assertLoanLockTransaction(transaction, { loanId, borrower: borrowerAddress, escrow: escrowAddress() });
  } catch (error) {
    // Un hash prouvé invalide ne doit pas empêcher la saisie du vrai lock.
    // Les erreurs RPC, avant cette validation, conservent au contraire SUBMITTING.
    await prisma.loan.updateMany({
      where: { id: loan.id, status: "SUBMITTING", evmLockTxHash: submittedLockTxHash },
      data: { status: "PENDING", evmLockTxHash: null },
    });
    throw error;
  }
  if (
    !onChain ||
    !addressesEqual(onChain.borrower, borrowerAddress) ||
    !addressesEqual(onChain.provider, loan.provider) ||
    onChain.datasetId.toLowerCase() !== loan.dataset.evmDatasetId.toLowerCase() ||
    onChain.trainingProfile.toLowerCase() !== trainingProfileHash(lockedModel).toLowerCase() ||
    onChain.status !== 1 ||
    onChain.amountUsdcAtomic !== loan.amountUsdcAtomic ||
    onChain.hashlock.toLowerCase() !== loan.evmHashlock.toLowerCase()
  ) {
    throw new AppError("Lock USDC hors scope de l’emprunt", 409);
  }
  const updated = await prisma.loan.updateMany({
    where: { id: loan.id, borrower: borrowerAddress, status: "SUBMITTING", evmLockTxHash: submittedLockTxHash },
    data: {
      status: "ESCROWED",
      evmLockBlock: receipt.blockNumber.toString(),
      evmDeadline: new Date(onChain.deadline * 1000),
    },
  });
  if (updated.count !== 1) throw new AppError("Lock USDC concurrent ou état local incohérent", 409);
  return prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
}
