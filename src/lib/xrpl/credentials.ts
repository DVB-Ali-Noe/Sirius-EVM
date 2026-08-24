import "server-only";
import {
  convertStringToHex,
  hashes,
  type CredentialAccept,
  type TransactionMetadata,
  type Wallet,
} from "xrpl";
import { AppError } from "@/lib/app-error";
import { getClient } from "./client";
import { assertTesSuccess, submitTx } from "./tx";

export const KYB_CREDENTIAL_TYPE = "KYB";
export const KYB_TYPE_HEX = convertStringToHex(KYB_CREDENTIAL_TYPE);

// lsfAccepted : le sujet a accepté le credential (XLS-70).
const LSF_ACCEPTED = 0x00010000;
const MAX_CREDENTIAL_PAGES = 5;

export type KybCredentialState = "absent" | "pending" | "accepted";

/** Sirius (issuer) émet un credential KYB pour une entité. */
export async function issueKyb(issuer: Wallet, subject: string) {
  const client = await getClient();
  return submitTx(
    client,
    {
      TransactionType: "CredentialCreate",
      Account: issuer.address,
      Subject: subject,
      CredentialType: KYB_TYPE_HEX,
    },
    issuer,
  );
}

/** L'entité (sujet) accepte le credential KYB émis par Sirius. */
export async function buildKybAccept(subject: string, issuer: string): Promise<CredentialAccept> {
  const client = await getClient();
  const input: CredentialAccept = {
    TransactionType: "CredentialAccept",
    Account: subject,
    Issuer: issuer,
    CredentialType: KYB_TYPE_HEX,
  };
  const transaction = await client.autofill(input);
  if (
    !Number.isSafeInteger(transaction.Sequence) ||
    !Number.isSafeInteger(transaction.LastLedgerSequence)
  ) {
    throw new AppError("LastLedgerSequence CredentialAccept manquant", 503);
  }
  return transaction;
}

export function assertKybAcceptScope(
  tx: CredentialAccept,
  subject: string,
  issuer: string,
): void {
  const flags = tx.Flags ?? 0;
  if (
    tx.TransactionType !== "CredentialAccept" ||
    tx.Account !== subject ||
    tx.Issuer !== issuer ||
    tx.CredentialType !== KYB_TYPE_HEX ||
    (flags !== 0 && flags !== 0x80000000) ||
    tx.Delegate !== undefined ||
    tx.Memos !== undefined ||
    tx.SourceTag !== undefined ||
    tx.TicketSequence !== undefined ||
    tx.AccountTxnID !== undefined ||
    !Number.isSafeInteger(tx.Sequence) ||
    !Number.isSafeInteger(tx.LastLedgerSequence)
  ) {
    throw new AppError("CredentialAccept hors scope du wallet", 400);
  }
}

export async function submitSignedKybAccept(txBlob: string): Promise<string> {
  const client = await getClient();
  const expectedHash = hashes.hashSignedTx(txBlob);
  try {
    const result = await client.submitAndWait(txBlob, { failHard: true });
    assertTesSuccess(result, "CredentialAccept");
    return result.result.hash;
  } catch (error) {
    try {
      const { result } = await client.request({ command: "tx", transaction: expectedHash, binary: false });
      const meta = result.meta as TransactionMetadata | string | undefined;
      if (
        result.validated &&
        meta &&
        typeof meta !== "string" &&
        meta.TransactionResult === "tesSUCCESS"
      ) {
        return expectedHash;
      }
    } catch {}
    throw error;
  }
}

/** Gating bloquant : l'entité possède-t-elle un KYB accepté émis par `issuer` ? */
export async function kybCredentialState(subject: string, issuer: string): Promise<KybCredentialState> {
  const client = await getClient();
  const state = (obj: unknown): KybCredentialState => {
    const c = obj as { Issuer?: string; Subject?: string; CredentialType?: string; Flags?: number };
    if (
      c.Subject === subject &&
      c.Issuer === issuer &&
      c.CredentialType === KYB_TYPE_HEX
    ) {
      return ((c.Flags ?? 0) & LSF_ACCEPTED) !== 0 ? "accepted" : "pending";
    }
    return "absent";
  };

  // Pagination via marker : un compte peut avoir plus d'objets que la limite par page.
  let marker: unknown;
  let pages = 0;
  do {
    const { result } = await client.request({
      command: "account_objects",
      account: subject,
      type: "credential",
      limit: 400,
      marker,
    });
    for (const object of result.account_objects) {
      const current = state(object);
      if (current !== "absent") return current;
    }
    marker = result.marker;
    pages += 1;
    if (marker && pages >= MAX_CREDENTIAL_PAGES) {
      throw new AppError("Trop d’objets XRPL pour vérifier le KYB", 503);
    }
  } while (marker);

  return "absent";
}

export async function hasAcceptedKyb(subject: string, issuer: string): Promise<boolean> {
  return (await kybCredentialState(subject, issuer)) === "accepted";
}
