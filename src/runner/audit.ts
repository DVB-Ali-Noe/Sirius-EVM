import "server-only";
import { convertStringToHex, Wallet } from "xrpl";
import { AppError } from "@/lib/app-error";
import { getClient } from "@/lib/xrpl/client";
import { submitTx } from "@/lib/xrpl/tx";
import type { LoanReceipt } from "@/lib/runner/receipt";

function auditWallet(): Wallet {
  const seed = process.env.XRPL_AUDIT_SIGNER_SEED ||
    (process.env.NODE_ENV !== "production" ? process.env.XRPL_VERIFIER_SEED : undefined);
  if (!seed) throw new Error("XRPL_AUDIT_SIGNER_SEED manquante dans le runner");
  return Wallet.fromSeed(seed);
}

export async function recordAuditReceipt(receipt: LoanReceipt): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(receipt.attestationHash)) {
    throw new AppError("Reçu d’emprunt sans attestation auditée", 409);
  }
  const wallet = auditWallet();
  const client = await getClient();
  const result = await submitTx(
    client,
    {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: receipt.provider,
      Amount: "1",
      Memos: [
        {
          Memo: {
            MemoType: convertStringToHex("sirius/audit"),
            MemoData: convertStringToHex(JSON.stringify({ loanId: receipt.loanId, payloadHash: receipt.attestationHash })),
          },
        },
      ],
    },
    wallet,
  );
  return result.result.hash;
}
