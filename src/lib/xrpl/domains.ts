import "server-only";
import type { Wallet } from "xrpl";
import { getClient } from "./client";
import { submitTx } from "./tx";

export interface AcceptedCredential {
  issuer: string;
  credentialType: string; // hex
}

/**
 * Crée ou met à jour un Permissioned Domain (XLS-80) listant les credentials acceptés.
 * Renvoie le DomainID (créé si `domainId` absent).
 */
export async function setPermissionedDomain(
  owner: Wallet,
  accepted: AcceptedCredential[],
  domainId?: string,
): Promise<string> {
  const client = await getClient();
  const res = await submitTx(
    client,
    {
      TransactionType: "PermissionedDomainSet",
      Account: owner.address,
      ...(domainId ? { DomainID: domainId } : {}),
      AcceptedCredentials: accepted.map((c) => ({
        Credential: { Issuer: c.issuer, CredentialType: c.credentialType },
      })),
    },
    owner,
  );

  if (domainId) return domainId;

  const meta = res.result.meta;
  const nodes = meta && typeof meta === "object" ? meta.AffectedNodes : [];
  for (const node of nodes) {
    if ("CreatedNode" in node && node.CreatedNode.LedgerEntryType === "PermissionedDomain") {
      return node.CreatedNode.LedgerIndex;
    }
  }
  throw new Error("DomainID introuvable après PermissionedDomainSet");
}
