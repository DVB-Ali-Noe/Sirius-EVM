import type { LoanJobInput, RunnerReleaseEnvelope } from "./contract";

/**
 * Attestation du calcul confidentiel.
 * Stub (dev) : signature serveur. Phala dstack (inc.3b) : quote TDX vérifiable on-chain.
 */
export interface Attestation {
  signer: string; // qui atteste (verifier serveur en stub, enclave en Phala)
  payloadHash: string; // hash(modèle + intégrité dataset + loanId)
  signature: string;
}

export interface TdxEvidence {
  quote: string;
  eventLog: string;
  composeHash: string;
}

export interface RunnerRaTlsEvidence extends TdxEvidence {
  certificateSha256: string;
  ingressKeySha256: string;
  masterKeyChainSha256: string;
}

/** Résultat d'un job : modèle livré (chiffré, sur IPFS) + métriques + preuve. */
export interface TeeResult {
  modelCid: string;
  metrics: Record<string, number>; // en clair au MVP (DP en roadmap, D-18)
  resultHash: string; // gravé on-chain au règlement (reçu d'audit)
  attestation: Attestation;
  quote?: string; // quote TDX matérielle (hex), mode phala uniquement — vérif externe (3d.2)
  quoteEventLog?: string;
  composeHash?: string;
}

/** Résultat d'un job d'emprunt : le job + le secret d'escrow, révélé uniquement à ce moment. */
export interface LoanJobResult extends TeeResult {
  conditionHex: string; // condition de l'escrow (pour EscrowFinish)
  fulfillmentHex: string; // secret de release — produit UNIQUEMENT par un job réussi (fair-exchange)
}

export interface PreparedLoanJobResult extends TeeResult {
  conditionHex: string;
  runnerReceipt: string;
  releaseEnvelope: RunnerReleaseEnvelope;
}

/**
 * Exécuteur de job confidentiel. Contrat fixe entrée→sortie, implémentation swappable :
 * StubTeeRunner (in-process, dev) → PhalaTeeRunner (enclave, via HTTP en CVM). Le Next passe
 * des inputs explicites (LoanJobInput) — le runner ne touche jamais la DB. Sélection par TEE_MODE.
 */
export interface TeeRunner {
  run(input: LoanJobInput): Promise<LoanJobResult>;
}
