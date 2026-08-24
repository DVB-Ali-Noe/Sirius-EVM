"use client";

import { useWalletStore } from "@/stores/wallet";
import { signMessageEmbedded } from "@/lib/web3auth/manager";
import { signMessageExternal } from "@/lib/wallet/manager";
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

  const { signature, publicKey } =
    source === "embedded"
      ? await signMessageEmbedded(challenge)
      : await signMessageExternal(challenge);

  const verifyRes = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, publicKey, signature, message: challenge, source }),
  });
  if (!verifyRes.ok) {
    clearRunnerDelegation();
    throw new Error("Authentification refusée");
  }

  activateRunnerDelegation({
    message: challenge,
    walletPublicKey: publicKey,
    walletSignature: signature,
    sessionPublicKey: runnerSessionPublicKey,
  });
  useWalletStore.getState().setAuthenticated(true);
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
