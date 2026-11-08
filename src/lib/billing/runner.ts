import "server-only";
import { keccak256, toHex, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { settlementAccount } from "@/lib/evm/runner-account";
import { getPublicClient } from "@/lib/evm/client";
import { usdcAddress } from "@/lib/evm/addresses";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { readLoan } from "@/lib/evm/escrow";
import { confirmedBlock } from "@/lib/evm/finality";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { MAX_DATASET_BYTES, type DatasetRef } from "@/lib/tee/contract";
import { runnerBudget } from "@/lib/runner/budget";
import { QUOTE_LIFETIME_SECONDS } from "@/lib/runner/budget-ledger";
import type { ModelId } from "@/lib/models/registry";
import {
  API_ACCESS_NOT_FOR_SALE, API_ACCESS_NOT_FOR_SALE_CODE, apiAccessComputeAmount, apiAccessDatasetAmount, isApiAccessDays,
  isCallPackSize, packDatasetAmount, type CallPackSize,
} from "./api-pricing";
import { billingPolicy, type BillingPolicy } from "./config";
import { computeQuoteHash, parseComputeQuote, quoteAuthorizationTypedData, verifyComputeQuote, type ComputeQuote, type SignedComputeQuote } from "./quote";
import { datasetAmountFor, isValidRentalDays } from "./rental";

export function loanWorkflowId(loanId: string, borrower: string, binding = evmEscrowBinding()): string {
  return `loan:${binding.chainId}:${binding.escrow.toLowerCase()}:${loanKeyFor(borrower, loanId)}`;
}

export function quoteWorkflow(quote: ComputeQuote) {
  return { id: loanWorkflowId(quote.loanId, quote.borrower, quote), fingerprint: computeQuoteHash(quote) };
}

export function requireBillingBudget() {
  const ledger = runnerBudget();
  const account = settlementAccount();
  if (!ledger || ledger.policy.wallet !== account.address.toLowerCase()) throw new AppError("Budget de facturation non configuré pour ce runner", 503);
  return ledger;
}

async function reclaimExpiredUnpaidQuotes(): Promise<void> {
  const ledger = requireBillingBudget();
  const client = getPublicClient();
  if (await client.getChainId() !== ledger.policy.chainId) throw new AppError("RPC sur un autre réseau", 503);
  const stable = await confirmedBlock(client, ledger.policy.gas.confirmations);
  for (const workflow of ledger.expiredUnusedWorkflows(Number(stable.timestamp) * 1000)) {
    let signed: SignedComputeQuote;
    try { signed = JSON.parse(workflow.payload) as SignedComputeQuote; }
    catch { throw new AppError("Budget de clôture hors scope", 503); }
    const quote = parseComputeQuote(signed.quote);
    if (computeQuoteHash(quote) !== workflow.fingerprint || quote.chainId !== ledger.policy.chainId
      || quote.runner !== ledger.policy.wallet || quote.expiresAt >= Number(stable.timestamp)) {
      throw new AppError("Budget de clôture hors scope", 503);
    }
    if (await readLoan(loanKeyFor(quote.borrower, quote.loanId), quote)) continue;
    ledger.releaseUnusedWorkflow(workflow);
  }
}

/** Quota quotidien d'API d'un profil ; absent (ou linéaire) : ni API ni pack d'appels. */
function callsPerDayFor(apiCallsPerDay: BillingPolicy["apiCallsPerDay"], modelId: ModelId): number {
  const calls = apiCallsPerDay[modelId];
  if (modelId === "linear_regression" || calls === undefined) {
    throw new AppError("API indisponible pour ce profil de modèle", 409, "api_not_available_for_profile");
  }
  return calls;
}

/**
 * Devis contre le dataset vérifié par le reçu runner. Prix par jour × `rentalDays` (D-29), durée
 * bornée par `maxRentalDays` du reçu ; un devis hérité (`rentalDays` nul) vaut le prix forfaitaire.
 * Un pack d'appels (D-30) vaut `callPack × ceil(prix par jour / apiCallsPerDay)`, quota lu dans
 * `apiCallsPerDay` (par défaut la politique installée) ; un pass d'accès API (D-32), le minimum du
 * contrat. Prolongation, pack et pass : aucune retenue d'échec.
 */
export function assertQuoteDataset(quote: ComputeQuote, dataset: DatasetRef, receipt: string, borrower: string, loanId: string,
  apiCallsPerDay?: BillingPolicy["apiCallsPerDay"]): void {
  const days = quote.rentalDays;
  const datasetAmount = days === null ? dataset.priceUsdcAtomic
    : !isValidRentalDays(days, dataset.maxRentalDays) ? null
      : quote.apiAccessDays !== undefined ? apiAccessDatasetAmount(quote.usdcDecimals)
        : quote.callPack === undefined ? datasetAmountFor(dataset.priceUsdcAtomic, days)
          : packDatasetAmount(dataset.priceUsdcAtomic, callsPerDayFor(apiCallsPerDay ?? billingPolicy().apiCallsPerDay, dataset.modelId), quote.callPack);
  const noTraining = quote.extendsLoanId !== undefined || quote.packForLoanId !== undefined;
  if (quote.loanId !== loanId || quote.borrower !== borrower.toLowerCase() || quote.datasetId !== dataset.datasetId
    || quote.datasetReceiptHash !== keccak256(toHex(receipt)) || quote.datasetAmount !== datasetAmount
    || (noTraining && quote.maxFailureFee !== "0")
    || quote.challengeDays !== dataset.challengeDays || quote.modelId !== dataset.modelId || quote.modelVersion !== dataset.modelVersion) {
    throw new AppError("Devis compute hors scope", 409);
  }
}

export async function runnerComputeQuote(value: unknown, requireUnexpired = false, binding = evmEscrowBinding()): Promise<SignedComputeQuote> {
  const signed = await verifyComputeQuote(value, { ...binding, runner: settlementAccount().address }, requireUnexpired);
  const stored = requireBillingBudget().workflowPayload(quoteWorkflow(signed.quote).id);
  if (!stored || computeQuoteHash((JSON.parse(stored) as SignedComputeQuote).quote) !== computeQuoteHash(signed.quote)) {
    throw new AppError("Budget de clôture hors scope", 409);
  }
  return signed;
}

/**
 * Montants signés d'un devis. Emprunt : prix par jour × jours, compute du profil relevé au minimum
 * de la politique. Prolongation (`extendsLoanId`) ou pack d'appels (`callPack`) : rien n'est
 * entraîné, le compute vaut `noTrainingComputeAmount` (prix coûtant, le contrat refuse 0) et
 * aucune retenue d'échec n'est possible. Le pack vaut `callPack × ceil(prix par jour / quota)`.
 * Pass d'accès API (`apiAccessDays`, D-32) : le fournisseur reçoit le minimum du contrat
 * (0,001 USDC), Sirius `apiAccessDays × apiAccessDailyComputeAmount` ; tarif sans ce champ : refus.
 * API incluse (`apiAccessIncluded`, emprunt ou prolongation) : `rentalDays × apiAccessDailyComputeAmount`
 * s'ajoute au compute (`apiAccessAmount`), retenue d'échec inchangée ; profil sans API ou tarif sans
 * prix journalier : refus.
 */
export function computeQuoteAmounts(policy: BillingPolicy, input: {
  dataset: Pick<DatasetRef, "modelId" | "priceUsdcAtomic">; rentalDays: number; extendsLoanId?: string;
  callPack?: CallPackSize; apiAccessDays?: number; apiAccessIncluded?: boolean;
}): { datasetAmount: string; computeAmount: string; maxFailureFee: string; apiAccessIncluded?: true; apiAccessAmount?: string } {
  const profile = policy.profiles[input.dataset.modelId];
  if (!profile) throw new AppError("Tarif compute absent, invalide ou périmé", 503);
  if (input.apiAccessIncluded && (input.apiAccessDays !== undefined || input.callPack !== undefined)) {
    throw new AppError("Accès API inclus du devis invalide", 409);
  }
  if (input.apiAccessDays !== undefined) {
    if (input.extendsLoanId !== undefined || input.callPack !== undefined) throw new AppError("Pack d’appels du devis invalide", 409);
    if (!isApiAccessDays(input.apiAccessDays)) throw new AppError("Nombre de jours d’accès API invalide", 400);
    const fee = policy.apiAccessDailyComputeAmount;
    if (fee === undefined) throw new AppError(API_ACCESS_NOT_FOR_SALE, 409, API_ACCESS_NOT_FOR_SALE_CODE);
    return {
      datasetAmount: apiAccessDatasetAmount(policy.usdcDecimals),
      computeAmount: apiAccessComputeAmount(fee, input.apiAccessDays), maxFailureFee: "0",
    };
  }
  if (input.callPack !== undefined) {
    if (input.extendsLoanId !== undefined) throw new AppError("Pack d’appels du devis invalide", 409);
    if (!isCallPackSize(input.callPack)) throw new AppError("Taille de pack d’appels invalide", 400);
    return {
      datasetAmount: packDatasetAmount(input.dataset.priceUsdcAtomic, callsPerDayFor(policy.apiCallsPerDay, input.dataset.modelId), input.callPack),
      computeAmount: policy.noTrainingComputeAmount, maxFailureFee: "0",
    };
  }
  const datasetAmount = datasetAmountFor(input.dataset.priceUsdcAtomic, input.rentalDays);
  const minimum = BigInt(policy.minimumComputeAmount);
  const configured = BigInt(profile.computeAmount);
  const base = input.extendsLoanId !== undefined
    ? { datasetAmount, computeAmount: policy.noTrainingComputeAmount, maxFailureFee: "0" }
    : { datasetAmount, computeAmount: String(configured > minimum ? configured : minimum), maxFailureFee: profile.maxFailureFee };
  if (!input.apiAccessIncluded) return base;
  callsPerDayFor(policy.apiCallsPerDay, input.dataset.modelId);
  const fee = policy.apiAccessDailyComputeAmount;
  if (fee === undefined) throw new AppError(API_ACCESS_NOT_FOR_SALE, 409, API_ACCESS_NOT_FOR_SALE_CODE);
  const apiAccessAmount = apiAccessComputeAmount(fee, input.rentalDays);
  return { ...base, computeAmount: (BigInt(base.computeAmount) + BigInt(apiAccessAmount)).toString(), apiAccessIncluded: true, apiAccessAmount };
}

/**
 * Devis d'un emprunt (`rentalDays` jours), d'une prolongation (`extendsLoanId`), d'un pack
 * d'appels (`callPack` + `packForLoanId`) ou d'un pass d'accès API (`apiAccessDays` +
 * `packForLoanId`), `rentalDays` recopié du prêt d'origine pour ces deux derniers : montants de
 * `computeQuoteAmounts`.
 */
export async function prepareComputeQuote(input: {
  dataset: DatasetRef; datasetReceipt: string; borrower: string; provider: string;
  loanId: string; onChainDatasetId: Hex; hashlock: Hex; authorizationDeadline: number;
  rentalDays: number; extendsLoanId?: string; callPack?: CallPackSize; packForLoanId?: string;
  /** Pass : jours, échéance de la location et couverture déjà payée relevées par l'enclave (base du prix). */
  apiAccessDays?: number; apiAccessRentalEnd?: number; apiAccessCoveredUntil?: number;
  /** API incluse (emprunt sur demande, prolongation d'un prêt couvert jusqu'à son échéance). */
  apiAccessIncluded?: boolean;
}): Promise<SignedComputeQuote> {
  const purchases = Number(input.callPack !== undefined) + Number(input.apiAccessDays !== undefined);
  if (purchases > 1 || (purchases === 1) !== (input.packForLoanId !== undefined)
    || (input.packForLoanId !== undefined && input.extendsLoanId !== undefined)) {
    throw new AppError("Pack d’appels du devis invalide", 400);
  }
  if (!isValidRentalDays(input.rentalDays, input.dataset.maxRentalDays)) {
    throw new AppError("Durée de location invalide", 400);
  }
  const binding = evmEscrowBinding();
  const ledger = requireBillingBudget();
  const existing = ledger.workflowPayload(loanWorkflowId(input.loanId, input.borrower));
  if (existing) {
    const signed = await runnerComputeQuote(JSON.parse(existing), true);
    assertQuoteDataset(signed.quote, input.dataset, input.datasetReceipt, input.borrower, input.loanId);
    if (signed.quote.onChainDatasetId !== input.onChainDatasetId || signed.quote.hashlock !== input.hashlock
      || signed.quote.provider !== input.provider.toLowerCase() || signed.quote.rentalDays !== input.rentalDays
      || signed.quote.extendsLoanId !== input.extendsLoanId || signed.quote.callPack !== input.callPack
      || (signed.quote.apiAccessDays === undefined) !== (input.apiAccessDays === undefined)
      || (signed.quote.apiAccessIncluded ?? false) !== (input.apiAccessIncluded ?? false)
      || signed.quote.packForLoanId !== input.packForLoanId) throw new AppError("Devis compute hors scope", 409);
    return signed;
  }
  await reclaimExpiredUnpaidQuotes();
  const policy = billingPolicy();
  const token = usdcAddress();
  const decimals = await getPublicClient().readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  if (policy.chainId !== binding.chainId || policy.usdc !== token.toLowerCase() || policy.usdcDecimals !== Number(decimals)) {
    throw new AppError("Token ou précision du tarif incohérent", 503);
  }
  const profile = policy.profiles[input.dataset.modelId];
  if (!profile) throw new AppError("Tarif compute absent, invalide ou périmé", 503);
  const amounts = computeQuoteAmounts(policy, input);
  const expiresAt = Math.min(input.authorizationDeadline, Math.floor(Date.now() / 1000) + QUOTE_LIFETIME_SECONDS, Math.floor(policy.validUntil / 1000));
  if (expiresAt * 1000 < Date.now() + 60000) throw new AppError("Devis compute expiré", 409);
  const quote = parseComputeQuote({
    version: 7, ...binding, escrow: binding.escrow.toLowerCase(), usdc: token.toLowerCase(), usdcDecimals: Number(decimals),
    runner: settlementAccount().address.toLowerCase(), loanId: input.loanId, datasetId: input.dataset.datasetId,
    onChainDatasetId: input.onChainDatasetId, datasetReceiptHash: keccak256(toHex(input.datasetReceipt)),
    borrower: input.borrower.toLowerCase(), provider: input.provider.toLowerCase(), computeRecipient: policy.computeRecipient,
    ...amounts,
    executionRateAtomicPerMs: profile.executionRateAtomicPerMs,
    maxExecutionMs: profile.maxExecutionMs, maxDatasetBytes: MAX_DATASET_BYTES, hashlock: input.hashlock,
    challengeDays: input.dataset.challengeDays, modelId: input.dataset.modelId, modelVersion: input.dataset.modelVersion,
    tariffVersion: policy.tariffVersion, expiresAt, failurePolicy: "consumed-execution-only", rentalDays: input.rentalDays,
    ...(input.extendsLoanId === undefined ? {} : { extendsLoanId: input.extendsLoanId }),
    ...(input.callPack === undefined ? {} : { callPack: input.callPack, packForLoanId: input.packForLoanId }),
    ...(input.apiAccessDays === undefined ? {} : {
      apiAccessDays: input.apiAccessDays, apiAccessRentalEnd: input.apiAccessRentalEnd, packForLoanId: input.packForLoanId,
      ...(input.apiAccessCoveredUntil === undefined ? {} : { apiAccessCoveredUntil: input.apiAccessCoveredUntil }),
    }),
  });
  const signature = await settlementAccount().signTypedData(quoteAuthorizationTypedData(quote));
  const signed: SignedComputeQuote = { quote, authorization: { deadline: quote.expiresAt, signature } };
  const gasBalance = await getPublicClient().getBalance({ address: settlementAccount().address, blockTag: "pending" });
  ledger.reserveWorkflow(quoteWorkflow(quote), JSON.stringify(signed), (quote.expiresAt + quote.challengeDays * 86400) * 1000, gasBalance);
  return signed;
}
