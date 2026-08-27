"use client";

import { useWalletStore } from "@/stores/wallet";
import { signMessageExternal } from "@/lib/wallet/manager";
import { ensureKybAttested } from "@/lib/kyb/client";
import {
  activateRunnerDelegation,
  beginRunnerDelegation,
  clearRunnerDelegation,
} from "@/lib/runner/authorization-client";

/**
 * Ouvre une session serveur : challenge → signature wallet → cookie httpOnly.
 * L'origine (`source`) route la signature vers le bon SDK.
 */
export async function signInWithWallet(): Promise<void> {
  const { address, source } = useWalletStore.getState();
  if (!address || !source) throw new Error("Aucun wallet connecté");

  const runnerSessionPublicKey = await beginRunnerDelegation();
  const chalRes = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, runnerSessionPublicKey }),
  });
  if (!chalRes.ok) {
    clearRunnerDelegation();
    throw new Error("Challenge refusé");
  }
  const { challenge } = await chalRes.json();

  const { signature } = await signMessageExternal(challenge, address);

  const verifyRes = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature, message: challenge, source }),
  });
  if (!verifyRes.ok) {
    clearRunnerDelegation();
    throw new Error("Authentification refusée");
  }

  activateRunnerDelegation({
    message: challenge,
    walletSignature: signature,
    sessionPublicKey: runnerSessionPublicKey,
  });
  useWalletStore.getState().setAuthenticated(true);

  // Posé dans la foulée, pendant que le portefeuille est encore sous la main.
  // L'escrow l'exigera de toute façon ; le découvrir au moment de verrouiller des
  // fonds serait le plus mauvais moment.
  await ensureKybAttested(address);
}

export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    clearRunnerDelegation();
    useWalletStore.getState().setAuthenticated(false);
  }
}

export async function invalidateWalletSession(): Promise<void> {
  clearRunnerDelegation();
  useWalletStore.getState().setAuthenticated(false);
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
}
