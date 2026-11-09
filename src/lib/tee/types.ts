import type { ModelId } from "@/lib/models/registry";

export interface Attestation {
  signer: string;
  payloadHash: string;
  signature: string;
}

export interface TdxEvidence {
  quote: string;
  eventLog: string;
  composeHash: string;
}

/** Versions 3 et 4 pour les nouvelles attestations ; 1 et 2 (avec `releaseEnvelopeHash`) restent lisibles. */
export interface LoanAttestationPayload {
  version: 1 | 2 | 3 | 4;
  kind: "sirius-loan-training";
  chainId: number;
  escrow: string;
  loanId: string;
  loanKey: string;
  datasetId: string;
  datasetCid: string;
  provider: string;
  borrower: string;
  amountUsdcAtomic: string;
  challengeDays: number;
  merkleRoot: string;
  modelId: ModelId;
  modelVersion: string;
  modelCid: string;
  /** Historique (versions 1 et 2) : empreinte de la capsule de livraison supprimée. */
  releaseEnvelopeHash?: string;
  billingQuoteHash?: string;
}

export interface LoanExecutionAttestation extends Attestation {
  payload: string;
  evidence: TdxEvidence | null;
}

export interface RunnerRaTlsEvidence extends TdxEvidence {
  certificateSha256: string;
  ingressKeySha256: string;
  masterKeyChainSha256: string;
  settlementAddress: string;
  bootstrapOnly: boolean;
}
