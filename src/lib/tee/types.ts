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

export interface RunnerRaTlsEvidence extends TdxEvidence {
  certificateSha256: string;
  ingressKeySha256: string;
  masterKeyChainSha256: string;
}
