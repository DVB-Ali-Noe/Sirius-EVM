import "server-only";
import { keccak256, stringToHex, verifyTypedData } from "viem";
import { AppError } from "@/lib/errors";
import { evmEscrowBinding } from "@/lib/tee/evm-binding";
import { requestDemoController } from "@/lib/phala-demo/controller-client";
import { phalaDemoInstance } from "@/lib/sirius/self-training-access";
import {
  isValidPredictionOutput,
  modelRefString,
  PREDICTION_DOMAIN_NAME,
  PREDICTION_DOMAIN_VERSION,
  PREDICTION_EIP712_TYPES,
  predictionOutputKind,
  type ModelRef,
  type SignedPrediction,
} from "@/lib/tee/contract";
import type { ModelId } from "@/lib/models/registry";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";

/**
 * Contrôles communs des routes de prédiction (`/api/train/[id]/predict`, `/api/loans/[id]/predict`).
 * Le modèle reste scellé dans le runner : la seule sortie est une prédiction signée, que la route
 * revalide entièrement avant de la rendre (forme, profil, sujet, variables, session, signature).
 */

const MAX_FEATURES = 31;
const MAX_FEATURE_ABS = 1e9;
const MAX_FEATURES_BYTES = 4096;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
export interface PredictionRequest {
  features: Record<string, number>;
  authorization: RunnerGrant;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Corps `{ features, authorization }` : variables numériques finies, bornées, au plus 31 et 4 Kio. */
export function parsePredictionRequest(body: unknown): PredictionRequest {
  const invalid = () => new AppError("Caractéristiques ou autorisation invalides", 400);
  if (!isPlainObject(body)) throw invalid();
  const { features, authorization } = body;
  if (!isPlainObject(features) || !isPlainObject(authorization)) throw invalid();
  const entries = Object.entries(features);
  if (!entries.length || entries.length > MAX_FEATURES
    || entries.some(([name, value]) => !name || typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_FEATURE_ABS)
    || Buffer.byteLength(JSON.stringify(features), "utf8") > MAX_FEATURES_BYTES) {
    throw invalid();
  }
  return { features: features as Record<string, number>, authorization: authorization as unknown as RunnerGrant };
}

/**
 * Révision de session signée dans la prédiction. Le grant doit viser l'opération `predict` et
 * exactement ce modèle. Sur une instance de démo Phala, la session doit être ouverte et le grant
 * porter sa révision courante ; ailleurs, aucune révision de démo et `sessionRevision = 0`.
 */
export async function predictionSessionRevision(ref: ModelRef, authorization: RunnerGrant): Promise<number> {
  const payload = authorization.payload;
  const scoped = ref.kind === "job" ? payload?.jobId : payload?.loanId;
  if (payload?.operation !== "predict" || scoped !== ref.id) {
    throw new AppError("Autorisation de prédiction invalide", 403);
  }
  if (!phalaDemoInstance()) {
    if (payload.demoSessionRevision !== undefined) throw new AppError("Autorisation de prédiction invalide", 403);
    return 0;
  }
  const demo = await requestDemoController();
  const revision = demo.sessionRevision;
  if (demo.phase !== "open" || !demo.available || typeof revision !== "number" || !Number.isSafeInteger(revision)
    || payload.demoSessionRevision !== revision) {
    throw new AppError("La démonstration est fermée ou l’autorisation a expiré", 403);
  }
  return revision;
}

export interface ExpectedPrediction {
  ref: ModelRef;
  modelId: ModelId;
  modelVersion: string;
  subject: string;
  features: Record<string, number>;
  sessionRevision: number;
}

/**
 * Revalide la réponse du runner et n'en recopie que les champs du contrat : aucune probabilité,
 * aucun score, aucun champ inattendu ne sort. La signature EIP-712 doit être celle de `signer`.
 */
export async function assertSignedPrediction(result: unknown, expected: ExpectedPrediction): Promise<SignedPrediction> {
  const fail = () => new AppError("Réponse de prédiction invalide", 502);
  if (!isPlainObject(result) || !isPlainObject(result.domain) || !isPlainObject(result.signedMessage)) throw fail();
  const { domain, signedMessage: message } = result;
  const modelRef = modelRefString(expected.ref);
  const outputKind = predictionOutputKind(expected.modelId);
  const { chainId } = evmEscrowBinding();
  if (
    result.modelRef !== modelRef || result.modelId !== expected.modelId || result.modelVersion !== expected.modelVersion
    || result.outputKind !== outputKind || typeof result.output !== "string" || !isValidPredictionOutput(outputKind, result.output)
    || typeof result.counter !== "number" || !Number.isSafeInteger(result.counter) || result.counter < 1
    || typeof result.signer !== "string" || !ADDRESS.test(result.signer)
    || typeof result.signature !== "string" || !SIGNATURE.test(result.signature)
    || domain.name !== PREDICTION_DOMAIN_NAME || domain.version !== PREDICTION_DOMAIN_VERSION || domain.chainId !== chainId
    || message.modelRef !== modelRef || message.modelId !== expected.modelId || message.modelVersion !== expected.modelVersion
    || typeof message.subject !== "string" || message.subject.toLowerCase() !== expected.subject.toLowerCase()
    || message.featuresHash !== keccak256(stringToHex(JSON.stringify(expected.features)))
    || message.outputKind !== result.outputKind || message.output !== result.output
    || message.counter !== result.counter || message.sessionRevision !== expected.sessionRevision
  ) {
    throw fail();
  }
  const signer = result.signer as `0x${string}`;
  const signature = result.signature as `0x${string}`;
  const signedMessage = {
    modelRef, modelId: expected.modelId, modelVersion: expected.modelVersion,
    subject: message.subject as `0x${string}`, featuresHash: message.featuresHash as `0x${string}`,
    outputKind, output: result.output, counter: result.counter, sessionRevision: expected.sessionRevision,
  };
  const authentic = await verifyTypedData({
    address: signer,
    domain: { name: PREDICTION_DOMAIN_NAME, version: PREDICTION_DOMAIN_VERSION, chainId },
    types: PREDICTION_EIP712_TYPES,
    primaryType: "Prediction",
    message: { ...signedMessage, counter: BigInt(signedMessage.counter), sessionRevision: BigInt(signedMessage.sessionRevision) },
    signature,
  }).catch(() => false);
  if (!authentic) throw fail();
  return {
    modelRef, modelId: expected.modelId, modelVersion: expected.modelVersion, outputKind, output: result.output,
    counter: result.counter, signer, signature,
    domain: { name: PREDICTION_DOMAIN_NAME, version: PREDICTION_DOMAIN_VERSION, chainId },
    signedMessage,
  } as SignedPrediction;
}
