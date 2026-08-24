import type { DatasetMetrics } from "@/lib/sirius/metrics";

export const MAX_DATASET_BYTES = 16 * 1024 * 1024;
export const DATASET_INGRESS_INFO_PREFIX = "sirius-dataset-ingress-v1:";

export interface DatasetIngressKey {
  version: 1;
  publicKey: string;
  origin: string;
}

export interface DatasetIngressEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface RunnerDeliveryEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

/**
 * Nature du secret qui verrouille une capsule, et donc de la chaîne qui le publiera.
 * Le champ est porté par la capsule elle-même pour qu'un client sache quel matériel
 * de sel employer — et pour qu'un rail refuse une capsule produite pour l'autre.
 */
export type RunnerReleaseKind = "xrpl-fulfillment" | "evm-preimage";

export interface RunnerReleaseEnvelope extends RunnerDeliveryEnvelope {
  release: RunnerReleaseKind;
}

/**
 * Verrou d'escrow EVM : préimage secret et son empreinte publique.
 *
 * Typés `0x${string}` et non `string` : ces valeurs traversent directement viem et le
 * contrat, où un hexadécimal sans préfixe serait interprété différemment. Le type
 * porte la convention plutôt que de la laisser à la discipline de l'appelant.
 */
export interface EvmEscrowLock {
  hashlock: `0x${string}`;
  preimage: `0x${string}`;
}

/**
 * Contrat de la frontière Next ↔ runner confidentiel (inc.3d-B). Le runner est le SEUL
 * détenteur de la master key enclave ; le Next lui passe des inputs explicites (jamais de
 * handle DB) et ne voit jamais plaintext / DEK / clé du modèle / fulfillment avant l'heure.
 */

/** Référence d'un dataset chiffré au repos (ce que le Next connaît sans jamais déchiffrer). */
export interface DatasetRef {
  datasetId: string; // contexte de wrap de la DEK
  cid: string; // blob chiffré sur IPFS
  wrappedKey: string; // DEK scellée
  merkleRoot: string; // intégrité vérifiée après déchiffrement
  priceDrops: string; // termes provider authentifiés par le reçu runner (rail XRPL)
  challengeDays: number;
  /**
   * Prix du provider en wei, pour le rail EVM.
   *
   * Champ distinct plutôt qu'une conversion depuis `priceDrops` : un prix exprimé en
   * drops XRP n'est pas un prix en wei ETH, et convertir mécaniquement inventerait une
   * parité qui n'existe pas. Le provider fixe un prix par chaîne.
   *
   * Optionnel pour ne pas invalider les datasets déjà scellés sur le rail historique ;
   * les opérations EVM l'exigent.
   */
  priceWei?: string;
}

/** Entrée d'un entraînement libre (self-train) : dataset + où livrer le modèle chiffré. */
export interface TrainingInput extends DatasetRef {
  keyContext: string; // contexte de la clé du modèle livré (redérivable pour la livraison)
  filename: string; // nom du blob modèle sur IPFS
}

/** Entrée d'un self-train : le runner dérive lui-même la clé et le nom du modèle. */
export interface SelfTrainingInput extends DatasetRef {
  jobId: string;
  owner: string;
}

/**
 * Entrée d'un job d'emprunt : juste la ref dataset + le `loanId`. Le contexte de clé et le
 * nom de blob sont dérivés du `loanId` DANS le runner (pas de champ libre côté appelant) →
 * un modèle ne peut pas être chiffré sous le contexte d'un autre emprunt.
 */
export interface LoanJobInput extends DatasetRef {
  loanId: string;
  borrower: string;
}

/** Sortie du scellement d'un dataset (upload provider) : rien de sensible ne fuit. */
export interface SealDatasetResult {
  cid: string;
  wrappedKey: string;
  merkleRoot: string;
  metrics: DatasetMetrics;
  sizeBytes: number;
}

export interface AuthorizedSealDatasetResult extends SealDatasetResult {
  runnerReceipt: string;
}

export interface AuthorizedTrainingResult {
  modelCid: string;
  metrics: Record<string, number>;
  runnerReceipt: string;
}

export type RunnerEscrowReconciliation =
  | { state: "active" }
  | { state: "cancelled"; txHash: string }
  | { state: "settled"; txHash: string };

/** Crypto-condition d'escrow : condition publique (EscrowCreate) + fulfillment secret (release). */
export interface EscrowCondition {
  conditionHex: string;
  fulfillmentHex: string;
}
