import "server-only";
import type {
  Client,
  SubmittableTransaction,
  TransactionMetadata,
  TxResponse,
  Wallet,
} from "xrpl";

export type TransactionReconciliation = "confirmed" | "failed" | "pending";

/** Garde sur le résultat moteur : lève si le code n'est pas tesSUCCESS. */
export function assertTesSuccess(res: TxResponse, txType: string): void {
  const meta = res.result.meta;
  const code = meta && typeof meta === "object" ? meta.TransactionResult : undefined;
  if (code !== "tesSUCCESS") {
    throw new Error(`Tx ${txType} échouée: ${code ?? "résultat inconnu"}`);
  }
}

/** Autofill + sign + submitAndWait, avec garde sur le résultat moteur (tesSUCCESS). */
export async function submitTx<T extends SubmittableTransaction>(
  client: Client,
  tx: T,
  wallet: Wallet,
): Promise<TxResponse<T>> {
  const res = await client.submitAndWait(tx, { autofill: true, failHard: true, wallet });
  assertTesSuccess(res, tx.TransactionType);
  return res;
}

export async function reconcileTransaction(
  client: Client,
  txHash: string,
  lastLedgerSequence: number,
): Promise<TransactionReconciliation> {
  try {
    const { result } = await client.request({ command: "tx", transaction: txHash, binary: false });
    if (!result.validated) return "pending";
    const meta = result.meta as TransactionMetadata | string | undefined;
    return meta && typeof meta !== "string" && meta.TransactionResult === "tesSUCCESS"
      ? "confirmed"
      : "failed";
  } catch (error) {
    if ((error as { data?: { error?: unknown } }).data?.error !== "txnNotFound") return "pending";
  }
  const ledgerIndex = await client.getLedgerIndex().catch(() => null);
  return ledgerIndex !== null && ledgerIndex > lastLedgerSequence ? "failed" : "pending";
}
