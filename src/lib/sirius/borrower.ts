import "server-only";
import type { Hex } from "viem";
import { prisma, serializableTransaction } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { datasetRegistryAddress, escrowAddress } from "@/lib/evm/addresses";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { requireCurrentEvmDeployment } from "@/lib/evm/deployment";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { readLoan } from "@/lib/evm/escrow";
import { approveUsdcTransaction, lockUsdcTransaction, lockQuotedUsdcTransaction } from "@/lib/evm/transaction";
import { billingEnabled } from "@/lib/billing/config";
import { computeQuoteHash, totalQuoteAmount } from "@/lib/billing/quote";
import { assertBilledLock, loanBillingQuote, verifyPreparedComputeQuote } from "@/lib/billing/loan";
import { prepareEscrowLockInRunner } from "@/lib/tee/runner-client";
import { lockAuthorizationDeadline } from "./lock-policy";
import { modelSelection, trainingProfileHash, type ModelSelection } from "@/lib/models/registry";
import { requireAcceptedKyb, requireCounterpartyKyb } from "./access";
import { BORROWABLE_STATUSES, isBorrowableDatasetStatus } from "./provider";
import { isListingExpired } from "@/lib/datasets/manage";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { recoverUnsubmittedLoan } from "./recover-loan";
import { assertLoanLockTransaction } from "@/lib/evm/history";
import { assertCurrentRunner } from "@/lib/runner/provenance";
import { assertAdmissionsOpen, assertExposureWithinCap, assertLoanWithinCap, EXPOSED_LOAN_STATUSES, exposureLimits } from "./exposure-limits";
import { datasetAmountFor, isValidRentalDays, MAX_RENTAL_DAYS, MIN_RENTAL_DAYS } from "@/lib/billing/rental";
import { requireRentalQuote } from "@/lib/billing/quote";
import { assertExtendableLoan } from "./rental";
import { isCallPackSize, packDatasetAmount, type CallPackSize } from "@/lib/billing/api-pricing";
import { assertApiLoan } from "./api-keys";

const MAX_PENDING_LOANS = 5;
const RATE_WINDOW_MS = 3_600_000;
const MAX_RUNS_PER_WINDOW = 3;

/**
 * Prêt rattaché à un prêt d'origine, au profil d'entraînement repris à l'identique : prolongation
 * (D-29), ou pack de `callPack` appels API prépayés (D-30) quand `callPack` est présent.
 */
export interface LoanExtensionTarget {
  originalLoanId: string;
  model: ModelSelection;
  /** Pack : taille et quota quotidien du profil (`apiCallsPerDay`), d'où le prix par appel. */
  pack?: { size: CallPackSize; callsPerDay: number };
}

/**
 * Prépare le lock d'un emprunt de `rentalDays` jours (1 à `maxRentalDays` du dataset), ou d'un prêt
 * rattaché à un prêt d'origine (`extension`) : prolongation, ou pack d'appels (`extension.pack`,
 * D-30). Avec devis (escrow v7), le montant dataset vaut prix par jour × jours, signé dans le devis
 * (`rentalDays`, `extendsLoanId`) ; pour un pack, taille × prix par appel (`packDatasetAmount`), les
 * jours du prêt d'origine étant repris sans en ajouter (`callPack`, `packForLoanId`). Sans devis
 * (escrow v6 hérité), le prix reste forfaitaire et le prêt n'a pas d'échéance ; ni prolongation ni
 * pack n'y sont possibles.
 */
export async function prepareLoan(datasetId: string, borrower: string, rentalDays: number, extension?: LoanExtensionTarget) {
  const borrowerAddress = normalizeAddress(borrower);
  assertAdmissionsOpen();
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
  // Une annonce expirée n'est plus empruntable, même par son lien direct.
  if (isListingExpired(dataset.listingExpiresAt)) throw new AppError("Annonce expirée", 409);
  if (!dataset.priceUsdcAtomic || !dataset.ipfsCid || !dataset.wrappedKey || !dataset.merkleRoot || !dataset.runnerReceipt) {
    throw new AppError("Dataset EVM incomplet", 409);
  }
  // Prolongation : profil du prêt d'origine, qui doit rester celui du dataset (contrôlé ci-dessous).
  const model = modelSelection(extension?.model.modelId ?? dataset.modelId, extension?.model.modelVersion ?? dataset.modelVersion);
  if (!model) throw new AppError("Profil d’entraînement du dataset absent ou invalide", 409);
  if (extension && (dataset.modelId !== model.modelId || dataset.modelVersion !== model.modelVersion)) {
    throw new AppError(`Profil d’entraînement du dataset modifié : ${extension.pack ? "achat d’appels" : "prolongation"} impossible`, 409);
  }
  if (!isValidRentalDays(rentalDays, dataset.maxRentalDays)) {
    throw new AppError(`Durée de location invalide (${MIN_RENTAL_DAYS} à ${Math.min(dataset.maxRentalDays, MAX_RENTAL_DAYS)} jours)`, 400);
  }
  const billed = billingEnabled();
  if (extension && !billed) throw new AppError(`${extension.pack ? "Achat d’appels" : "Prolongation"} indisponible sans devis compute`, 503);
  const pack = extension?.pack ? { ...extension.pack, originalLoanId: extension.originalLoanId } : undefined;
  const amountUsdcAtomic = !billed ? dataset.priceUsdcAtomic
    : pack ? packDatasetAmount(dataset.priceUsdcAtomic, pack.callsPerDay, pack.size) : datasetAmountFor(dataset.priceUsdcAtomic, rentalDays);
  // Plafonds de la bêta : refus avant tout appel au runner, puis de nouveau sur le total du devis.
  const limits = exposureLimits();
  assertLoanWithinCap(amountUsdcAtomic, limits);
  const runner = await assertCurrentRunner(dataset);
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

  const loan = await serializableTransaction(async (tx) => {
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
    // Un prêt PENDING sans hash de lock n'a rien coûté à l'emprunteur mais compte dans le plafond
    // d'exposition de la bêta tant que le reaper ne l'a pas annulé (son autorisation de lock reste
    // renouvelable jusqu'à neuf minutes après sa création, il peut donc encore être verrouillé).
    // Une nouvelle préparation remplace donc les PENDING non payés du même emprunteur, comme le
    // reaper les annule après leur TTL : un compte ne réserve jamais gratuitement plus d'un plafond
    // par prêt, et refuser un devis ou fermer la fenêtre ne bloque pas la préparation suivante
    // (audit du 5 octobre, A-06 et A-18). Un lock tardif sur un prêt ainsi annulé reste récupérable
    // par `finalizeLoan` et le reaper (CANCELLED sans `cancelTxHash`).
    await tx.loan.updateMany({
      where: { borrower: borrowerAddress, status: "PENDING", evmLockTxHash: null },
      data: { status: "CANCELLED" },
    });
    if (limits) {
      const exposed = await tx.loan.findMany({ where: { status: { in: [...EXPOSED_LOAN_STATUSES] } }, select: { amountUsdcAtomic: true } });
      assertExposureWithinCap(exposed.map((row) => row.amountUsdcAtomic), amountUsdcAtomic, limits);
    }
    const available = await tx.dataset.updateMany({
      where: {
        id: datasetId,
        status: { in: [...BORROWABLE_STATUSES] },
        evmDatasetId: { not: null },
        wrappedKey: { not: null },
        runnerReceipt: { not: null },
        OR: [{ listingExpiresAt: null }, { listingExpiresAt: { gt: new Date() } }],
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
        extendsLoanId: extension && !pack ? extension.originalLoanId : null,
        packForLoanId: pack?.originalLoanId ?? null,
        callPack: pack?.size ?? null,
        ...runner,
      },
    });
  });

  try {
    const binding = evmEscrowBinding();
    const preparedBlock = await getPublicClient().getBlockNumber({ cacheTime: 0 });
    const rental = {
      rentalDays,
      ...(extension && !pack ? { extendsLoanId: extension.originalLoanId } : {}),
      ...(pack ? { callPack: pack.size, packForLoanId: pack.originalLoanId } : {}),
    };
    const { hashlock, authorization, billingQuote } = await prepareEscrowLockInRunner({
      datasetId, cid: dataset.ipfsCid, wrappedKey: dataset.wrappedKey, merkleRoot: dataset.merkleRoot,
      priceUsdcAtomic: dataset.priceUsdcAtomic, challengeDays: dataset.challengeDays, maxRentalDays: dataset.maxRentalDays, ...model,
    }, dataset.runnerReceipt, loan.id, borrowerAddress,
    lockAuthorizationDeadline(loan.createdAt), rental);
    if (billed !== Boolean(billingQuote)) throw new AppError("Devis compute absent du prêt", 503);
    const signedQuote = billingQuote ? await verifyPreparedComputeQuote(billingQuote) : undefined;
    if (signedQuote && (signedQuote.quote.datasetAmount !== amountUsdcAtomic || signedQuote.quote.onChainDatasetId !== dataset.evmDatasetId
      || signedQuote.quote.hashlock !== hashlock || signedQuote.quote.rentalDays !== rentalDays
      || (signedQuote.quote.extendsLoanId ?? null) !== (rental.extendsLoanId ?? null)
      || (signedQuote.quote.callPack ?? null) !== (rental.callPack ?? null)
      || (signedQuote.quote.packForLoanId ?? null) !== (rental.packForLoanId ?? null))) throw new AppError("Devis compute hors scope", 409);
    const total = signedQuote ? totalQuoteAmount(signedQuote.quote) : amountUsdcAtomic;
    assertLoanWithinCap(total, limits);
    const loanKey = loanKeyFor(borrowerAddress, loan.id);
    // Le contrôle sur le total du devis et l'enregistrement de ce total partagent une transaction
    // sérialisable : deux préparations simultanées ne peuvent pas se voir mutuellement au seul prix
    // du dataset et dépasser le plafond à elles deux (audit du 5 octobre, A-33).
    const prepared = await serializableTransaction(async (tx) => {
      if (limits) {
        const exposed = await tx.loan.findMany({
          where: { id: { not: loan.id }, status: { in: [...EXPOSED_LOAN_STATUSES] } },
          select: { amountUsdcAtomic: true },
        });
        assertExposureWithinCap(exposed.map((row) => row.amountUsdcAtomic), total, limits);
      }
      return tx.loan.update({
        where: { id: loan.id },
        data: {
          ...(signedQuote ? {
            amountUsdcAtomic: total, billingQuote: JSON.stringify(signedQuote), billingQuoteHash: computeQuoteHash(signedQuote.quote),
            datasetAmountUsdcAtomic: signedQuote.quote.datasetAmount, computeAmountUsdcAtomic: signedQuote.quote.computeAmount,
            maxFailureFeeUsdcAtomic: signedQuote.quote.maxFailureFee, rentalDays: signedQuote.quote.rentalDays,
          } : {}),
          evmLoanKey: loanKey,
          evmHashlock: hashlock,
          evmChainId: binding.chainId,
          evmEscrowAddress: binding.escrow,
          evmPreparedBlock: preparedBlock.toString(),
          evmDeadline: new Date(Date.now() + dataset.challengeDays * 86_400_000),
        },
      });
    });
    if (signedQuote) loanBillingQuote(prepared);
    return {
      loan: prepared,
      billingQuote: signedQuote,
      approveTransaction: approveUsdcTransaction(total),
      lockTransaction: signedQuote ? lockQuotedUsdcTransaction(signedQuote) : lockUsdcTransaction({
        provider: dataset.provider,
        datasetId: dataset.evmDatasetId as Hex,
        amount: amountUsdcAtomic,
        hashlock,
        challengeDays: dataset.challengeDays,
        loanId: loan.id,
        trainingProfile: trainingProfileHash(model),
        authorization,
      }),
    };
  } catch (error) {
    await prisma.loan.deleteMany({ where: { id: loan.id, status: "PENDING" } });
    throw error;
  }
}

export async function renewLoanLock(loanId: string, borrower: string) {
  const address = normalizeAddress(borrower);
  // Une nouvelle autorisation de lock ferait entrer des fonds : fermée elle aussi par le coupe-circuit.
  assertAdmissionsOpen();
  await requireCurrentEvmDeployment();
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: { omit: { wrappedKey: false } } } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(loan.borrower, address)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  const dataset = loan.dataset;
  const signedQuote = loanBillingQuote(loan);
  // Devis hérité (sans durée) d'une préparation d'avant D-29 : il n'est plus renouvelable.
  const rentalDays = signedQuote ? requireRentalQuote(signedQuote.quote).rentalDays : null;
  const binding = evmEscrowBinding();
  if (loan.status === "CANCELLED" && !loan.evmLockTxHash) {
    throw new AppError("Préparation d’emprunt annulée (expirée ou remplacée par une préparation plus récente) : relance l’emprunt, l’approbation du stablecoin reste acquise", 409);
  }
  if (loan.status !== "PENDING" || loan.evmLockTxHash || !loan.evmLoanKey ||
    loan.evmChainId !== binding.chainId || loan.evmEscrowAddress !== binding.escrow) {
    throw new AppError("Emprunt déjà soumis ou déploiement modifié", 409);
  }
  const deadline = lockAuthorizationDeadline(loan.createdAt);
  const model = modelSelection(loan.modelId, loan.modelVersion);
  // Pack (D-30) : la location d'origine doit rester active, et le prix suivre la même règle qu'à la préparation.
  const packOrigin = loan.packForLoanId ? await assertApiLoan(loan.packForLoanId, address, { requireActiveRental: true }) : null;
  if (packOrigin && !isCallPackSize(loan.callPack)) throw new AppError("Taille de pack d’appels invalide", 409);
  const expectedDatasetAmount = rentalDays === null ? loan.amountUsdcAtomic
    : packOrigin ? packDatasetAmount(dataset.priceUsdcAtomic, packOrigin.callsPerDay, loan.callPack as CallPackSize)
      : datasetAmountFor(dataset.priceUsdcAtomic, rentalDays);
  if (!model || !isBorrowableDatasetStatus(dataset.status) || !dataset.evmDatasetId || !dataset.ipfsCid ||
    !dataset.wrappedKey || !dataset.merkleRoot || !dataset.runnerReceipt ||
    (signedQuote?.quote.datasetAmount ?? dataset.priceUsdcAtomic) !== expectedDatasetAmount ||
    dataset.modelId !== model.modelId || dataset.modelVersion !== model.modelVersion) {
    throw new AppError("Dataset EVM non disponible", 409);
  }
  // Prolongation : la location d'origine doit rester ouverte jusqu'à la signature du lock.
  if (loan.extendsLoanId) await assertExtendableLoan(loan.extendsLoanId, address);
  if (isListingExpired(dataset.listingExpiresAt)) throw new AppError("Annonce expirée", 409);
  if (await readLoan(loan.evmLoanKey as Hex)) throw new AppError("Emprunt déjà verrouillé", 409);
  await assertCurrentRunner(loan);
  await assertCurrentRunner(dataset);
  // Sans devis (escrow v6 hérité), la durée n'entre dans aucun terme signé : le runner l'ignore.
  const rental = {
    rentalDays: rentalDays ?? MIN_RENTAL_DAYS,
    ...(loan.extendsLoanId ? { extendsLoanId: loan.extendsLoanId } : {}),
    ...(packOrigin ? { callPack: loan.callPack as CallPackSize, packForLoanId: packOrigin.id } : {}),
  };
  const { hashlock, authorization, billingQuote } = await prepareEscrowLockInRunner({
    datasetId: dataset.id, cid: dataset.ipfsCid, wrappedKey: dataset.wrappedKey, merkleRoot: dataset.merkleRoot,
    priceUsdcAtomic: dataset.priceUsdcAtomic, challengeDays: dataset.challengeDays, maxRentalDays: dataset.maxRentalDays, ...model,
  }, dataset.runnerReceipt, loan.id, address, deadline, rental);
  if (hashlock !== loan.evmHashlock) throw new AppError("Hashlock du runner modifié", 409);
  if (Boolean(signedQuote) !== Boolean(billingQuote)) throw new AppError("Devis compute hors scope", 409);
  if (billingQuote) {
    const verified = await verifyPreparedComputeQuote(billingQuote);
    if (computeQuoteHash(verified.quote) !== loan.billingQuoteHash) throw new AppError("Devis compute hors scope", 409);
  }
  return {
    authorizationDeadline: authorization.deadline,
    billingQuote,
    lockTransaction: billingQuote ? lockQuotedUsdcTransaction(billingQuote) : lockUsdcTransaction({
      provider: loan.provider, datasetId: dataset.evmDatasetId as Hex, amount: loan.amountUsdcAtomic,
      hashlock, challengeDays: dataset.challengeDays, loanId, trainingProfile: trainingProfileHash(model), authorization,
    }),
  };
}

export async function finalizeLoan(loanId: string, borrower: string, lockTxHash?: string) {
  const borrowerAddress = normalizeAddress(borrower);
  const loan = await prisma.loan.findUnique({ where: { id: loanId }, include: { dataset: { omit: { wrappedKey: false } } } });
  if (!loan) throw new AppError("Loan introuvable", 404);
  if (!addressesEqual(loan.borrower, borrowerAddress)) throw new AppError("Accès refusé : emprunt d’un autre compte", 403);
  if (loan.status === "ESCROWED" && loan.evmLockTxHash) return prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
  const recoverableCancellation = loan.status === "CANCELLED" && !loan.cancelTxHash;
  if (loan.status !== "PENDING" && loan.status !== "SUBMITTING" && !recoverableCancellation) {
    throw new AppError("Emprunt déjà clôturé", 409);
  }
  if (!loan.evmLoanKey || !loan.evmHashlock || !loan.amountUsdcAtomic) throw new AppError("Emprunt EVM non préparé", 409);
  const submittedLockTxHash = lockTxHash ?? loan.evmLockTxHash;
  if (!submittedLockTxHash || !/^0x[0-9a-fA-F]{64}$/.test(submittedLockTxHash)) {
    throw new AppError("Hash de lock de paiement manquant", 400);
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
      throw new AppError("Lock de paiement non confirmé : actualise son état", 409);
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
    throw new AppError("Soumission de lock de paiement concurrente", 409);
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
    if (receipt.status !== "success") throw new AppError("Transaction de lock de paiement rejetée", 409);
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
    throw new AppError("Lock de paiement hors scope de l’emprunt", 409);
  }
  assertBilledLock(loan, onChain);
  const updated = await prisma.loan.updateMany({
    where: { id: loan.id, borrower: borrowerAddress, status: "SUBMITTING", evmLockTxHash: submittedLockTxHash },
    data: {
      status: "ESCROWED",
      evmLockBlock: receipt.blockNumber.toString(),
      evmDeadline: new Date(onChain.deadline * 1000),
    },
  });
  if (updated.count !== 1) throw new AppError("Lock de paiement concurrent ou état local incohérent", 409);
  return prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
}
