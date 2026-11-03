import "server-only";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKey, getMasterKey } from "@/lib/crypto/encryption";
import { predictionOutput } from "@/lib/models/predict";
import { extendableLoanModel, extendLoanRental, hasSealedLoanModel, loadServedModel, recordLoanExpiry, servedModelFingerprint } from "@/lib/tee/served-models";
import { reservePrediction } from "@/lib/runner/prediction-usage";
import {
  escrowHashlock,
  escrowLock,
  runEvmLoanJob,
  runBilledEvmLoanJob,
  runSelfTraining,
  sealDatasetEnvelope,
} from "@/lib/tee/core";
import { attestLoanExecution } from "@/lib/tee/attestation";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { assertLoanScope, authorizeEscrowLock, publishedFinalizedPreimage, publishedPreimage, settleEscrow } from "@/lib/evm/escrow";
import { assertDatasetScope } from "@/lib/evm/dataset";
import { isValidUsdcAtomicAmount } from "@/lib/evm/usdc";
import { loanIdHash, loanKeyFor } from "@/lib/evm/loan-key";
import { normalizeAddress } from "@/lib/evm/address";
import { datasetIdHash } from "@/lib/evm/dataset-key";
import { datasetRegistryAddress } from "@/lib/evm/addresses";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { getPublicClient } from "@/lib/evm/client";
import { canonicalSubject } from "@/lib/subject";
import { trainingProfileHash, type ModelSelection } from "@/lib/models/registry";
import { assertLockedProfile, requestedTrainingProfile, type ProfileAdmission } from "@/lib/runner/profile-admission";
import { AppError } from "@/lib/app-error";
import { datasetIngressPublicKey } from "@/lib/tee/ingress";
import { verifyRunnerGrant } from "@/lib/runner/authorization";
import { assertTrialSubject, budgetRunnerJob, budgetRunnerRequest, runnerBudget, withWorkflowBudget } from "@/lib/runner/budget";
import { billingEnabled } from "@/lib/billing/config";
import { assertQuoteDataset, prepareComputeQuote, quoteWorkflow, requireBillingBudget, runnerComputeQuote } from "@/lib/billing/runner";
import { failBilledEscrow, settleBilledEscrow } from "@/lib/billing/settlement";
import { recoverBilledLoanResult } from "@/lib/billing/recovery";
import {
  issueDatasetReceipt,
  issueLoanReceipt,
  issueTrainingReceipt,
  verifyDatasetReceipt,
  verifyLoanReceipt,
  verifySettledLoanReceipt,
  type LoanReceipt,
} from "@/lib/runner/receipt";
import {
  MAX_DATASET_BYTES,
  MODEL_REF_ID_PATTERN,
  PREDICTION_DOMAIN_NAME,
  PREDICTION_DOMAIN_VERSION,
  PREDICTION_EIP712_TYPES,
  modelRefString,
  type DatasetIngressEnvelope,
  type DatasetRef,
  type LoanJobResult,
  type ModelRef,
  type SignedPrediction,
} from "@/lib/tee/contract";
import { checkDemoOperation, demoGrantScope, predictionSessionRevision, withDemoAdmission } from "@/lib/phala-demo/runner-session";
import type { RunnerOperation, RunnerScope } from "@/lib/runner/capability";
import { fastFinalityPolicy } from "@/lib/evm/finality";
import { enclaveFinalityTier, type FinalityTier } from "@/lib/evm/fast-finality";
import { parseComputeQuote, requireRentalQuote, totalQuoteAmount, type ComputeQuote } from "@/lib/billing/quote";
import { DAY_MS, MAX_RENTAL_DAYS, MIN_RENTAL_DAYS } from "@/lib/billing/rental";
import { RunnerRetryLater } from "@/lib/runner/failure-policy";
import { LOCK_FINALITY_PENDING } from "@/lib/loans/settlement-status";

const MAX_ID_LENGTH = 128;

/**
 * Palier de finalité d'un prêt v7, arbitré par l'enclave seule (fast-finality.ts). Le montant vient
 * du devis qu'elle a signé et que `matchesScope` lie aux termes on-chain, jamais du corps de la
 * requête ; les bornes viennent de son environnement attesté (Compose). Next peut demander le
 * palier rapide, l'enclave ne l'accorde que si sa politique l'admet pour ce montant, et refuse
 * explicitement sinon : jamais de profondeur rapide pour un prêt au-dessus du seuil.
 *
 * Cette décision ne réserve rien : règlement et prédiction la reprennent telle quelle. Le
 * plafond d'exposition de l'enclave (`reserveFastExposure`) n'est engagé qu'au lancement du calcul,
 * une fois le lock lu à la profondeur rapide : voir `run-loan-job`.
 */
function loanFinalityTier(requested: unknown, quote: ComputeQuote): FinalityTier {
  const tier = enclaveFinalityTier(requested, BigInt(totalQuoteAmount(quote)), fastFinalityPolicy());
  if (tier === null) throw new AppError("Finalité rapide refusée par l’enclave pour ce prêt", 409);
  return tier;
}

/**
 * Plafond d'exposition propre à l'enclave : la somme des prêts rapides verrouillés non libérés est
 * tenue dans son registre persistant (`fast_exposure`, budget-ledger.ts) et bornée par la constante
 * attestée SIRIUS_FAST_FINALITY_TOTAL_USDC. Appelé au lancement seulement, après lecture du lock à
 * la profondeur rapide ; idempotent pour un même prêt ; la part est rendue au release ou au
 * remboursement confirmés, à l'échec définitif du règlement, et purgée après l'échéance du prêt.
 * Jamais sur une prédiction : le release l'a déjà rendue, la réserver à nouveau figerait le
 * plafond jusqu'à l'échéance de prêts pourtant clos.
 */
function reserveFastExposure(quote: ComputeQuote): boolean {
  const config = fastFinalityPolicy();
  const deadlineMs = (quote.expiresAt + quote.challengeDays * 86_400) * 1_000;
  return requireBillingBudget().reserveFastExposure(quoteWorkflow(quote), BigInt(totalQuoteAmount(quote)), config.totalInFlightAtomic, deadlineMs);
}
const MAX_CID_LENGTH = 256;
const MAX_WRAPPED_KEY_LENGTH = 1_024;
const MAX_RECEIPT_LENGTH = 8_192;

function text(body: Record<string, unknown>, key: string, maxLength = MAX_ID_LENGTH): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value;
}

function boundedInteger(body: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AppError(`${key} invalide`, 400);
  }
  return value as number;
}

function usdcAmount(body: Record<string, unknown>, key: string): string {
  const value = text(body, key, 26);
  if (!isValidUsdcAtomicAmount(value)) throw new AppError(`${key} invalide`, 400);
  return value;
}

function datasetRef(body: Record<string, unknown>, admission: ProfileAdmission = "offered"): DatasetRef {
  return {
    datasetId: text(body, "datasetId"),
    cid: text(body, "cid", MAX_CID_LENGTH),
    wrappedKey: text(body, "wrappedKey", MAX_WRAPPED_KEY_LENGTH),
    merkleRoot: text(body, "merkleRoot", 128),
    priceUsdcAtomic: usdcAmount(body, "priceUsdcAtomic"),
    challengeDays: boundedInteger(body, "challengeDays", 1, 30),
    maxRentalDays: boundedInteger(body, "maxRentalDays", MIN_RENTAL_DAYS, MAX_RENTAL_DAYS),
    ...trainingModel(body, admission),
  };
}

/** Un profil facultatif reste refusé tant que l'image ne l'active pas, sauf pour un prêt déjà payé : voir profile-admission.ts. */
function trainingModel(body: Record<string, unknown>, admission: ProfileAdmission = "offered"): ModelSelection {
  return requestedTrainingProfile(body, admission);
}

function ingressEnvelope(body: Record<string, unknown>): DatasetIngressEnvelope {
  const value = body.envelope;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("Enveloppe dataset manquante", 400);
  }
  return value as DatasetIngressEnvelope;
}

function modelRef(body: Record<string, unknown>): ModelRef {
  const value = body.modelRef;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) {
    throw new AppError("modelRef invalide", 400);
  }
  const { kind, id } = value as Record<string, unknown>;
  if ((kind !== "job" && kind !== "loan") || typeof id !== "string" || !MODEL_REF_ID_PATTERN.test(id)) {
    throw new AppError("modelRef invalide", 400);
  }
  return { kind, id };
}

const MAX_PREDICTION_FEATURES = 31;
const MAX_PREDICTION_BYTES = 4_096;

/** Variables numériques finies, |x| ≤ 1e9, 31 au plus, 4 096 octets au plus une fois sérialisées. */
function predictionFeatures(body: Record<string, unknown>): { features: Record<string, number>; serialized: string } {
  const features = body.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    throw new AppError("Variables de prédiction invalides", 400);
  }
  const entries = Object.entries(features);
  if (entries.length < 1 || entries.length > MAX_PREDICTION_FEATURES || entries.some(([name, value]) =>
    name.length === 0 || typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e9)) {
    throw new AppError("Variables de prédiction invalides", 400);
  }
  const serialized = JSON.stringify(features);
  if (Buffer.byteLength(serialized) > MAX_PREDICTION_BYTES) throw new AppError("Variables de prédiction trop volumineuses", 413);
  return { features: features as Record<string, number>, serialized };
}

export function scopeForRunnerOp(op: string, body: Record<string, unknown>): { op: RunnerOperation; scope: RunnerScope } {
  switch (op) {
    case "dataset-ingress-key":
      return { op, scope: {} };
    case "seal-dataset":
      return { op, scope: { datasetId: text(body, "datasetId") } };
    case "prepare-escrow-lock":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId"), borrower: text(body, "borrower") } };
    case "run-loan-job":
      return { op, scope: { datasetId: text(body, "datasetId"), loanId: text(body, "loanId") } };
    case "settle-loan":
    case "extend-loan":
    case "recover-loan-job":
      return { op, scope: { loanId: text(body, "loanId") } };
    case "run-training":
      return { op, scope: { datasetId: text(body, "datasetId"), jobId: text(body, "jobId") } };
    case "predict": {
      const ref = modelRef(body);
      return { op, scope: ref.kind === "job" ? { jobId: ref.id } : { loanId: ref.id } };
    }
    default:
      throw new AppError("Opération runner inconnue", 404);
  }
}

/**
 * Clé publique d'ingestion : aucun coût sponsorisé (pas de réservation dans le registre de
 * budget). La facturer laissait n'importe quel visiteur épuiser le budget de la démonstration en
 * boucle. Le registre reste exigé (production, Phala, mainnet).
 *
 * Gratuite ne veut pas dire sans travail (audit ROB-08) : la capability est consommée dans
 * l'anti-rejeu SQLite (écriture synchronisée). Débit, concurrence et coupe-circuit sont donc
 * bornés à part, dans le serveur (`free-ops-guard.ts`), sans prendre de place aux opérations
 * payantes.
 */
export const UNCHARGED_OPS: ReadonlySet<RunnerOperation> = new Set(["dataset-ingress-key"]);

export async function handleRunnerOp(op: RunnerOperation, body: Record<string, unknown>): Promise<unknown> {
  checkDemoOperation(op);
  if (billingEnabled() && (op === "run-loan-job" || op === "settle-loan" || op === "extend-loan" || op === "recover-loan-job")) return executeRunnerOp(op, body);
  if (UNCHARGED_OPS.has(op)) {
    runnerBudget();
    return executeRunnerOp(op, body);
  }
  return budgetRunnerRequest(() => executeRunnerOp(op, body));
}

async function executeRunnerOp(op: RunnerOperation, body: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "dataset-ingress-key":
      return datasetIngressPublicKey();

    case "seal-dataset": {
      const datasetId = text(body, "datasetId");
      const priceUsdcAtomic = usdcAmount(body, "priceUsdcAtomic");
      const challengeDays = boundedInteger(body, "challengeDays", 1, 30);
      const maxRentalDays = boundedInteger(body, "maxRentalDays", MIN_RENTAL_DAYS, MAX_RENTAL_DAYS);
      const sizeBytes = boundedInteger(body, "sizeBytes", 1, MAX_DATASET_BYTES);
      const envelope = ingressEnvelope(body);
      const model = trainingModel(body);
      const demoScope = demoGrantScope();
      const { subject } = await verifyRunnerGrant(body.authorization, {
        ...demoScope,
        operation: op,
        datasetId,
        intentParts: [
          datasetId,
          priceUsdcAtomic,
          String(challengeDays),
          String(sizeBytes),
          envelope.ciphertext,
          model.modelId,
          model.modelVersion,
          String(maxRentalDays),
        ],
      });
      const result = await withDemoAdmission(`seal:${datasetId}`, canonicalSubject(subject),
        { envelope, sizeBytes, model, priceUsdcAtomic, challengeDays, maxRentalDays }, () => budgetRunnerJob("seal", [evmEscrowBinding(), canonicalSubject(subject), datasetId],
        { envelope, sizeBytes, model, priceUsdcAtomic, challengeDays, maxRentalDays },
        () => sealDatasetEnvelope(datasetId, envelope, sizeBytes, model)), demoScope.demoSessionRevision);
      return {
        ...result,
        runnerReceipt: issueDatasetReceipt(subject, {
          datasetId,
          cid: result.cid,
          wrappedKey: result.wrappedKey,
          merkleRoot: result.merkleRoot,
          priceUsdcAtomic,
          challengeDays,
          maxRentalDays,
          ...model,
        }),
      };
    }

    case "prepare-escrow-lock": {
      const dataset = datasetRef(body);
      const loanId = text(body, "loanId");
      const borrower = canonicalSubject(text(body, "borrower"));
      const receipt = verifyDatasetReceipt(text(body, "datasetReceipt", MAX_RECEIPT_LENGTH), dataset);
      const provider = normalizeAddress(receipt.owner);
      assertTrialSubject(borrower);
      assertTrialSubject(provider);
      if (provider === borrower) throw new AppError("Un provider ne peut pas emprunter son propre dataset", 400);
      await assertDatasetScope({ ...dataset, provider, model: dataset });
      const onChainDatasetId = await getPublicClient().readContract({
        address: datasetRegistryAddress(), abi: siriusdatasetregistryAbi, functionName: "datasetIdOf",
        args: [provider, datasetIdHash(dataset.datasetId)],
      });
      const hashlock = escrowHashlock(loanId, borrower);
      if (billingEnabled()) {
        const rentalDays = boundedInteger(body, "rentalDays", MIN_RENTAL_DAYS, MAX_RENTAL_DAYS);
        const extendsLoanId = body.extendsLoanId === undefined ? undefined : text(body, "extendsLoanId");
        if (extendsLoanId !== undefined) {
          // Refus avant tout lock : une prolongation n'est payée que pour un modèle encore scellé à l'emprunteur.
          const original = extendableLoanModel(extendsLoanId);
          if (original.owner !== borrower) throw new AppError("Prolongation réservée à l’emprunteur", 403);
          if (original.model.algo !== dataset.modelId) throw new AppError("Prolongation hors scope", 409);
        }
        const billingQuote = await prepareComputeQuote({
          dataset, datasetReceipt: text(body, "datasetReceipt", MAX_RECEIPT_LENGTH), borrower, provider, loanId,
          onChainDatasetId, hashlock, authorizationDeadline: boundedInteger(body, "authorizationDeadline", 1, 2 ** 40 - 1),
          rentalDays, ...(extendsLoanId === undefined ? {} : { extendsLoanId }),
        });
        return { hashlock, authorization: billingQuote.authorization, billingQuote };
      }
      const authorization = await authorizeEscrowLock({
        borrower, provider, amount: BigInt(receipt.priceUsdcAtomic), hashlock,
        challengeDays: receipt.challengeDays, loanIdHash: loanIdHash(loanId),
        datasetId: onChainDatasetId, trainingProfile: trainingProfileHash(dataset),
      }, boundedInteger(body, "authorizationDeadline", 1, 2 ** 40 - 1));
      return { hashlock, authorization };
    }

    case "run-loan-job": {
      // Prêt déjà payé : l'interrupteur des profils facultatifs est jugé après lecture du devis signé.
      const dataset = datasetRef(body, "locked");
      const loanId = text(body, "loanId");
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op,
        datasetId: dataset.datasetId,
        loanId,
        intentParts: [loanId, dataset.datasetId, datasetReceiptToken, dataset.modelId, dataset.modelVersion, "served"],
      });
      const borrower = canonicalSubject(subject);
      const loanKey = loanKeyFor(borrower, loanId);
      const hashlock = escrowHashlock(loanId, borrower);
      const signedQuote = billingEnabled() ? await runnerComputeQuote(body.billingQuote) : undefined;
      if (signedQuote) assertQuoteDataset(signedQuote.quote, dataset, datasetReceiptToken, borrower, loanId);
      // Une prolongation ne paie que la durée (compute minimal) : elle ne lance jamais d'entraînement.
      if (signedQuote?.quote.extendsLoanId !== undefined) throw new AppError("Prolongation : aucun entraînement", 409);
      assertLockedProfile(dataset, signedQuote);
      const candidateTier: FinalityTier = signedQuote ? loanFinalityTier(body.finalityTier, signedQuote.quote) : "FULL";
      const loanScope = (finalityTier: FinalityTier) => assertLoanScope({
        loanKey,
        borrower,
        provider: datasetReceipt.owner,
        datasetId: dataset.datasetId,
        amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
        hashlock,
        model: dataset,
        ...(signedQuote ? { billingQuote: signedQuote.quote, finalityTier } : {}),
      });
      const execute = async () => {
        await Promise.all([
          assertDatasetScope({
            datasetId: dataset.datasetId,
            provider: datasetReceipt.owner,
            merkleRoot: dataset.merkleRoot,
            cid: dataset.cid,
            model: dataset,
          }),
          loanScope(candidateTier),
        ]);
        // Lock lu à la profondeur rapide : la part de ce prêt entre maintenant dans le plafond de
        // l'enclave. Plafond atteint ⇒ le prêt est traité à finalité complète si son lock est déjà
        // sous le bloc finalisé ; sinon « en attente », le même message que Next rend à la page
        // Train pour un lock pas encore stable, sans compter d'échec ni consommer de crédit (le
        // palier de Next, lui, reste rapide : il réessaie, le plafond se libère au fil des releases).
        if (signedQuote && candidateTier === "FAST" && !reserveFastExposure(signedQuote.quote)) {
          console.warn(`[runner] plafond d'exposition rapide atteint : prêt ${loanId} traité à finalité complète`);
          try { await loanScope("FULL"); } catch { throw new RunnerRetryLater(LOCK_FINALITY_PENDING); }
        }

        if (signedQuote) {
          requireBillingBudget().prepareWorkflowResult(quoteWorkflow(signedQuote.quote), JSON.stringify({
            datasetCid: dataset.cid, merkleRoot: dataset.merkleRoot,
          }));
        }
        let result;
        try {
          result = signedQuote
            ? await runBilledEvmLoanJob({ ...dataset, loanId, borrower }, signedQuote.quote)
            : await runEvmLoanJob({ ...dataset, loanId, borrower });
        } catch (error) {
          if (signedQuote) {
            await failBilledEscrow(signedQuote.quote, loanKey);
            throw new AppError("Calcul échoué : remboursement crédité après retenue des frais consommés", 422);
          }
          throw error;
        }
        if (signedQuote) {
          const recovered = await recoverBilledLoanResult(signedQuote);
          if (recovered.state !== "ready") throw new AppError("Résultat durable manquant", 503);
          return recovered.result;
        }
        const { chainId, escrow } = evmEscrowBinding();
        const attestation = await attestLoanExecution({
          chainId,
          escrow,
          loanId,
          loanKey,
          datasetId: dataset.datasetId,
          datasetCid: dataset.cid,
          provider: datasetReceipt.owner,
          borrower,
          amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
          challengeDays: datasetReceipt.challengeDays,
          merkleRoot: dataset.merkleRoot,
          modelId: dataset.modelId,
          modelVersion: dataset.modelVersion,
          modelCid: result.modelCid,
        });
        const loanResult: LoanJobResult = {
          modelCid: result.modelCid,
          metrics: result.metrics,
          features: result.features,
          attestation,
          loanKey,
          hashlock,
          runnerReceipt: issueLoanReceipt({
            loanId,
            datasetId: dataset.datasetId,
            borrower,
            provider: datasetReceipt.owner,
            modelCid: result.modelCid,
            loanKey,
            chainId,
            escrow,
            amountUsdcAtomic: datasetReceipt.priceUsdcAtomic,
            challengeDays: datasetReceipt.challengeDays,
            modelId: dataset.modelId,
            modelVersion: dataset.modelVersion,
            attestationHash: attestation.payloadHash,
          }),
        };
        return loanResult;
      };
      return signedQuote ? withWorkflowBudget(quoteWorkflow(signedQuote.quote), () => budgetRunnerRequest(execute)) : execute();
    }

    case "recover-loan-job": {
      if (!billingEnabled()) throw new AppError("Reprise réservée aux prêts v7", 409);
      const loanId = text(body, "loanId");
      const signed = await runnerComputeQuote(body.billingQuote);
      if (signed.quote.loanId !== loanId) throw new AppError("Devis compute hors scope", 409);
      const ledger = requireBillingBudget();
      const scope = quoteWorkflow(signed.quote);
      const stored = ledger.workflowResult(scope);
      if (!stored) return { state: "missing" };
      if (!ledger.executionEvidence(scope)) return { state: "pending" };
      // Résultat d'avant la suppression de la livraison : aucun modèle scellé, donc rien à régler.
      const result: unknown = stored.result ? JSON.parse(stored.result) : null;
      const storedModelCid = result && typeof result === "object" && "modelCid" in result && typeof result.modelCid === "string"
        ? result.modelCid : null;
      if (stored.result && (!storedModelCid || !hasSealedLoanModel(loanId, signed.quote.borrower, storedModelCid))) return { state: "missing" };
      return withWorkflowBudget(quoteWorkflow(signed.quote), () => budgetRunnerRequest(() => recoverBilledLoanResult(signed)));
    }

    case "settle-loan": {
      const loanId = text(body, "loanId");
      const loanReceiptToken = text(body, "loanReceipt", MAX_RECEIPT_LENGTH);
      const receipt = verifyLoanReceipt(loanReceiptToken, loanId);
      const { preimage } = escrowLock(loanId, receipt.borrower);
      if (!hasSealedLoanModel(loanId, receipt.borrower, receipt.modelCid)) {
        throw new AppError("Modèle scellé absent : règlement refusé, remboursement à l’échéance", 409);
      }
      const lockBlock = BigInt(text(body, "lockBlock", 20));
      if (billingEnabled()) {
        const signedQuote = await runnerComputeQuote(receipt.billingQuote);
        if (signedQuote.quote.loanId !== loanId || signedQuote.quote.borrower !== receipt.borrower) throw new AppError("Devis compute hors scope", 409);
        if (body.authorization) {
          const { subject } = await verifyRunnerGrant(body.authorization, {
            operation: op, loanId, intentParts: [loanId, loanReceiptToken],
          });
          if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Règlement réservé au borrower", 403);
        }
        const finalityTier = loanFinalityTier(body.finalityTier, signedQuote.quote);
        return withWorkflowBudget(quoteWorkflow(signedQuote.quote), () => budgetRunnerRequest(async () => {
          const settleTxHash = await settleBilledEscrow(signedQuote.quote, receipt.loanKey as `0x${string}`, preimage, lockBlock, finalityTier);
          const expiresAt = await recordRentalExpiry(loanId, signedQuote.quote, settleTxHash);
          return { settleTxHash, ...(expiresAt === undefined ? {} : { expiresAt }) };
        }));
      }
      const { subject } = await verifyRunnerGrant(body.authorization, {
        operation: op, loanId, intentParts: [loanId, loanReceiptToken],
      });
      if (canonicalSubject(subject) !== receipt.borrower) throw new AppError("Règlement réservé au borrower", 403);
      return { settleTxHash: await settleEscrow(receipt.loanKey as `0x${string}`, preimage, lockBlock) };
    }

    case "extend-loan": {
      if (!billingEnabled()) throw new AppError("Prolongation réservée aux prêts v7", 409);
      const loanId = text(body, "loanId");
      const originalLoanId = text(body, "originalLoanId");
      const original = verifySettledLoanReceipt(text(body, "loanReceipt", MAX_RECEIPT_LENGTH), originalLoanId);
      if (!original.billingQuote || parseComputeQuote(original.billingQuote.quote).rentalDays === null) {
        throw new AppError("Prêt sans durée de location : prolongation impossible", 409);
      }
      const quote = requireRentalQuote((await runnerComputeQuote(body.billingQuote)).quote);
      if (quote.loanId !== loanId || quote.extendsLoanId !== originalLoanId || quote.datasetId !== original.datasetId
        || quote.modelId !== original.modelId || quote.modelVersion !== original.modelVersion) throw new AppError("Prolongation hors scope", 409);
      if (quote.borrower !== original.borrower) throw new AppError("Prolongation réservée à l’emprunteur", 403);
      if (body.authorization) {
        const { subject } = await verifyRunnerGrant(body.authorization, {
          operation: op, loanId, intentParts: [loanId, originalLoanId],
        });
        if (canonicalSubject(subject) !== original.borrower) throw new AppError("Prolongation réservée à l’emprunteur", 403);
      }
      // Modèle d'origine purgé (ou au-delà du délai de grâce) : refus avant tout release, le lock
      // de prolongation reste remboursable à son échéance.
      const sealed = extendableLoanModel(originalLoanId);
      if (sealed.owner !== original.borrower || servedModelFingerprint(sealed.model) !== original.modelCid) {
        throw new AppError("Prolongation hors scope", 409);
      }
      const lockBlock = BigInt(text(body, "lockBlock", 20));
      const finalityTier = loanFinalityTier(body.finalityTier, quote);
      const { preimage } = escrowLock(loanId, quote.borrower);
      const loanKey = loanKeyFor(quote.borrower, loanId);
      // Release immédiat, sans entraînement, puis échéance repoussée : `settleBilledEscrow` vérifie
      // le lock on-chain (termsHash du devis) et rejoue la même transaction après une coupure ;
      // `extendLoanRental` n'applique qu'une fois chaque prolongation.
      return withWorkflowBudget(quoteWorkflow(quote), () => budgetRunnerRequest(async () => {
        const settleTxHash = await settleBilledEscrow(quote, loanKey, preimage, lockBlock, finalityTier);
        return { settleTxHash, expiresAt: extendLoanRental(originalLoanId, loanId, await releaseTimeMs(settleTxHash), quote.rentalDays) };
      }));
    }

    case "run-training": {
      const dataset = datasetRef(body);
      const jobId = text(body, "jobId");
      const datasetReceiptToken = text(body, "datasetReceipt", MAX_RECEIPT_LENGTH);
      const datasetReceipt = verifyDatasetReceipt(datasetReceiptToken, dataset);
      const demoScope = demoGrantScope();
      const { subject } = await verifyRunnerGrant(body.authorization, {
        ...demoScope,
        operation: op,
        datasetId: dataset.datasetId,
        jobId,
        intentParts: [dataset.datasetId, jobId, datasetReceiptToken, dataset.modelId, dataset.modelVersion, "served"],
      });
      if (canonicalSubject(subject) !== canonicalSubject(datasetReceipt.owner)) {
        throw new AppError("Self-train réservé au propriétaire", 403);
      }
      await assertDatasetScope({
        datasetId: dataset.datasetId,
        provider: datasetReceipt.owner,
        merkleRoot: dataset.merkleRoot,
        cid: dataset.cid,
        model: dataset,
      });
      const result = await withDemoAdmission(`train:${jobId}`, canonicalSubject(subject), { ...dataset, jobId },
        () => runSelfTraining({ ...dataset, jobId, owner: subject }), demoScope.demoSessionRevision);
      return {
        ...result,
        runnerReceipt: issueTrainingReceipt({
          jobId,
          datasetId: dataset.datasetId,
          owner: subject,
          modelCid: result.modelCid,
          modelId: dataset.modelId,
          modelVersion: dataset.modelVersion,
        }),
      };
    }

    case "predict": {
      const ref = modelRef(body);
      const { features, serialized } = predictionFeatures(body);
      const loanReceipt = ref.kind === "loan" ? verifySettledLoanReceipt(text(body, "loanReceipt", MAX_RECEIPT_LENGTH), ref.id) : undefined;
      const revision = predictionSessionRevision();
      const { subject } = await verifyRunnerGrant(body.authorization, {
        ...demoGrantScope(),
        operation: op,
        ...(ref.kind === "job" ? { jobId: ref.id } : { loanId: ref.id }),
        intentParts: [ref.kind, ref.id, serialized],
      });
      const caller = canonicalSubject(subject);
      if (predictionSessionRevision() !== revision) throw new AppError("Session Phala remplacée ; renouvelle l’autorisation", 409);
      if (loanReceipt && caller !== loanReceipt.borrower) throw new AppError("Prédiction réservée à l’emprunteur", 403);
      const predict = async (): Promise<SignedPrediction> => {
        if (loanReceipt) await assertLoanSettled(loanReceipt, body);
        const served = loadServedModel(ref);
        if (!served) throw new AppError("Modèle indisponible", 404);
        if (served.owner !== caller) throw new AppError("Prédiction réservée au propriétaire", 403);
        if (loanReceipt && served.model.algo !== loanReceipt.modelId) throw new AppError("Modèle indisponible", 409);
        // Échéance de location (horloge système de la CVM) : refus avant tout décompte de quota.
        if (served.expiresAt !== undefined && Date.now() >= served.expiresAt) throw new AppError("Location expirée : prolonge pour continuer", 403);
        const names = served.model.features;
        if (Object.keys(features).length !== names.length || names.some((name) => !Object.hasOwn(features, name))) {
          throw new AppError("Variables de prédiction hors modèle", 400);
        }
        const values = names.map((name) => features[name]);
        const counter = reservePrediction(caller, ref, revision);
        let output;
        try {
          output = predictionOutput(served.model, values);
        } catch {
          throw new AppError("Prédiction numérique instable", 422);
        }
        const modelRefText = modelRefString(ref);
        const account = privateKeyToAccount(`0x${deriveKey(getMasterKey(), "prediction:sign:v1").toString("hex")}`);
        const domain = { name: PREDICTION_DOMAIN_NAME, version: PREDICTION_DOMAIN_VERSION, chainId: evmEscrowBinding().chainId } as const;
        const signedMessage = {
          modelRef: modelRefText, modelId: served.model.algo, modelVersion: served.model.version,
          subject: caller as `0x${string}`, featuresHash: keccak256(stringToHex(serialized)),
          outputKind: output.outputKind, output: output.output, counter, sessionRevision: revision,
        };
        const signature = await account.signTypedData({
          domain, primaryType: "Prediction", types: PREDICTION_EIP712_TYPES,
          message: { ...signedMessage, counter: BigInt(counter), sessionRevision: BigInt(revision) },
        });
        if (predictionSessionRevision() !== revision) throw new AppError("Session Phala remplacée ; renouvelle l’autorisation", 409);
        return {
          modelRef: modelRefText, modelId: served.model.algo, modelVersion: served.model.version,
          outputKind: output.outputKind, output: output.output, counter, signer: account.address, signature,
          domain, signedMessage,
        };
      };
      return predict();
    }
  }
}

/**
 * Le modèle d'un prêt ne sert qu'après règlement confirmé : v7, la transaction `release` publiée
 * à la profondeur du palier ; v6, le préimage publié par l'escrow. Sinon 409. Un prêt v7 loué
 * reçoit à cette occasion son échéance, si son règlement ne l'a pas déjà fixée.
 */
async function assertLoanSettled(receipt: LoanReceipt, body: Record<string, unknown>): Promise<void> {
  if (receipt.billingQuote) {
    const signed = await runnerComputeQuote(receipt.billingQuote, false, receipt);
    const settleTxHash = text(body, "settleTxHash", 66);
    if (!/^0x[0-9a-fA-F]{64}$/.test(settleTxHash)) throw new AppError("Hash de règlement invalide", 400);
    await publishedFinalizedPreimage(receipt.loanKey as `0x${string}`,
      settleTxHash as `0x${string}`, signed.quote,
      requireBillingBudget().policy.gas.confirmations, loanFinalityTier(body.finalityTier, signed.quote));
    await recordRentalExpiry(receipt.loanId, signed.quote, settleTxHash);
  } else await publishedPreimage(receipt.loanKey as `0x${string}`, receipt);
}

/** Horodatage (ms) du bloc d'une transaction `release` déjà vérifiée : départ de la location. */
async function releaseTimeMs(settleTxHash: string): Promise<number> {
  const client = getPublicClient();
  const { blockNumber } = await client.getTransactionReceipt({ hash: settleTxHash as `0x${string}` });
  return Number((await client.getBlock({ blockNumber })).timestamp) * 1_000;
}

/**
 * Échéance d'un prêt v7 réglé : bloc du `release` + `rentalDays` jours, enregistrée une fois dans
 * les métadonnées du modèle scellé (jamais écrasée : les prolongations la repoussent). Devis
 * hérité (sans durée) : aucune échéance.
 */
async function recordRentalExpiry(loanId: string, quote: ComputeQuote, settleTxHash: string): Promise<number | undefined> {
  if (quote.rentalDays === null) return undefined;
  const recorded = loadServedModel({ kind: "loan", id: loanId })?.expiresAt;
  if (recorded !== undefined) return recorded;
  return recordLoanExpiry(loanId, await releaseTimeMs(settleTxHash) + quote.rentalDays * DAY_MS);
}
