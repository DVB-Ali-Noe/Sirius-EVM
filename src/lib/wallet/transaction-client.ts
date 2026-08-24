"use client";

import { signTransactionEmbedded } from "@/lib/web3auth/manager";
import { signTransactionExternal } from "@/lib/wallet/manager";
import { useWalletStore } from "@/stores/wallet";

export async function signActiveTransaction(
  transaction: Record<string, unknown>,
): Promise<string> {
  const { source, authenticated } = useWalletStore.getState();
  if (!source) throw new Error("Connecte un wallet.");
  if (!authenticated) throw new Error("Authentifie-toi avant de signer.");
  return source === "embedded"
    ? signTransactionEmbedded(transaction)
    : signTransactionExternal(transaction);
}
