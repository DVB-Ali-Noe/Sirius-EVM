import type { CertificateViewProps } from "@/app/certificate/[loanId]/certificate-view";
import { EVM_CHAIN_IDS, EVM_CHAINS, type EvmNetwork } from "@/lib/evm/networks";
import { transactionExplorerUrl } from "@/lib/evm/explorer";
import { formatCertificateDate, presentVerification, type VerificationOutcome } from "./presentation";
import type { CertificateRecord } from "./resolve";

/**
 * Projection d'un certificat prêt vers les seules propriétés affichées. C'est la
 * frontière de confidentialité de la page : le payload d'attestation (adresses, montant,
 * clé de prêt) reste côté serveur et ne passe que par le téléchargement JSON.
 */

function networkForChain(chainId: number): EvmNetwork | null {
  for (const network of Object.keys(EVM_CHAIN_IDS) as EvmNetwork[]) {
    if (EVM_CHAIN_IDS[network] === chainId) return network;
  }
  return null;
}

export function certificateDownloadPath(loanId: string): string {
  return `/api/certificate/${encodeURIComponent(loanId)}/attestation`;
}

export function certificateViewProps(
  record: CertificateRecord,
  outcome: VerificationOutcome,
): CertificateViewProps | null {
  const network = networkForChain(record.settlement.chainId);
  if (!network) return null;
  return {
    datasetName: record.dataset.name.trim() || "Untitled dataset",
    proofHref: `/proof/${encodeURIComponent(record.dataset.id)}`,
    modelName: record.model.name,
    modelCid: record.model.cid,
    settledAt: formatCertificateDate(record.settledAt),
    networkLabel: EVM_CHAINS[network].name,
    settlementTxHash: record.settlement.txHash,
    settlementHref: transactionExplorerUrl(network, record.settlement.txHash),
    attestationHash: record.evidence.payloadHash,
    downloadHref: certificateDownloadPath(record.loanId),
    presentation: presentVerification(outcome),
  };
}
