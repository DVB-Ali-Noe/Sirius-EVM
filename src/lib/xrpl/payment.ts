import "server-only";
import { xrpToDrops, type Payment } from "xrpl";
import { getClient } from "./client";
import { assertTesSuccess } from "./tx";

/**
 * Autofill d'un `Payment` XRP SANS signature : le blob signé provient du wallet de
 * l'expéditeur (embarqué ou externe). Sert de sortie de secours non-custodial (D-20) —
 * l'utilisateur retire/envoie ses fonds vers n'importe quelle adresse. Le backend
 * re-vérifie l'`Account` puis soumet (cf. submitSignedPayment).
 */
export async function buildPayment(
  account: string,
  destination: string,
  amountXrp: string,
): Promise<Payment> {
  const client = await getClient();
  const tx: Payment = {
    TransactionType: "Payment",
    Account: account,
    Destination: destination,
    Amount: xrpToDrops(amountXrp),
  };
  return client.autofill(tx);
}

/** Soumet un `Payment` déjà signé côté client (tx_blob) + garde tesSUCCESS. */
export async function submitSignedPayment(txBlob: string): Promise<string> {
  const client = await getClient();
  const res = await client.submitAndWait(txBlob, { failHard: true });
  assertTesSuccess(res, "Payment");
  return res.result.hash;
}
