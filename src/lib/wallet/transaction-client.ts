"use client";

import { sendTransactionExternal } from "@/lib/wallet/manager";
import { useWalletStore } from "@/stores/wallet";

export async function sendActiveTransaction(
  transaction: Record<string, unknown>,
): Promise<string> {
  const { source, authenticated } = useWalletStore.getState();
  if (!source) throw new Error("Connecte un wallet.");
  if (!authenticated) throw new Error("Authentifie-toi avant de signer.");
  return sendTransactionExternal(transaction);
}
