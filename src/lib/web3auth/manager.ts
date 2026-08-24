"use client";

import { Web3Auth, WALLET_CONNECTORS, AUTH_CONNECTION } from "@web3auth/modal";
import { buildWeb3AuthOptions } from "./config";

/**
 * Singleton Web3Auth piloté en impératif (comme lib/wallet/manager pour xrpl-connect).
 * On évite volontairement le `Web3AuthProvider` React du modal, qui force un
 * `WalletServicesPlugin` incompatible XRPL (log "Unsupported chain namespace").
 * Le SDK touche `window` → tout est instancié côté client, dans le factory async.
 */
let web3authPromise: Promise<Web3Auth> | null = null;

export function getWeb3Auth(): Promise<Web3Auth> {
  if (web3authPromise) return web3authPromise;

  web3authPromise = (async () => {
    try {
      const w3a = new Web3Auth(buildWeb3AuthOptions());
      await w3a.init();
      return w3a;
    } catch (err) {
      // Permet un retry au prochain appel plutôt que de rester bloqué.
      web3authPromise = null;
      throw err;
    }
  })();

  return web3authPromise;
}

/**
 * Login social Google. Gardé contre le double-appel ("Wallet is not ready yet, Already connecting").
 * `mfaLevel: "optional"` → l'écran d'ajout d'un 2e facteur est proposé (skippable) : le compte
 * repose sinon sur le seul facteur Google (perte de l'accès Google = fonds perdus, cf D-20).
 */
export async function loginWithGoogle(): Promise<void> {
  const w3a = await getWeb3Auth();
  if (w3a.connected || w3a.status === "connecting") return;
  await w3a.connectTo(WALLET_CONNECTORS.AUTH, {
    authConnection: AUTH_CONNECTION.GOOGLE,
    mfaLevel: "optional",
  });
}

/** True si le compte embarqué a au moins un facteur de récupération configuré. */
export async function getEmbeddedMfaEnabled(): Promise<boolean> {
  const w3a = await getWeb3Auth();
  if (!w3a.connected) return false;
  const info = (await w3a.getUserInfo()) as { isMfaEnabled?: boolean };
  return info?.isMfaEnabled === true;
}

/**
 * Ouvre le flow Web3Auth pour sécuriser le compte : ajout d'un 2e facteur (`enableMFA`)
 * si aucun n'existe, sinon gestion des facteurs (`manageMFA`). Selon l'uxMode, peut
 * recharger la page → l'état MFA est de toute façon relu à la reconnexion.
 */
export async function secureEmbeddedAccount(): Promise<void> {
  const w3a = await getWeb3Auth();
  if (!w3a.connected) throw new Error("Wallet embarqué non connecté");
  const info = (await w3a.getUserInfo()) as { isMfaEnabled?: boolean };
  if (info?.isMfaEnabled) await w3a.manageMFA();
  else await w3a.enableMFA();
}

export async function logoutEmbedded(): Promise<void> {
  const w3a = await getWeb3Auth();
  if (w3a.connected) await w3a.logout({ cleanup: false });
}

/** Adresse XRPL dérivée localement (op locale, pas de réseau). Null si non connecté. */
export async function getEmbeddedAddress(): Promise<string | null> {
  const w3a = await getWeb3Auth();
  const provider = w3a.getConnector(WALLET_CONNECTORS.AUTH)?.provider;
  if (!provider) return null;
  const accounts = await provider.request<never, string[]>({ method: "xrpl_getAccounts" });
  return accounts?.[0] ?? null;
}

function toHex(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signe le challenge d'auth avec la clé XRPL embarquée. Le handler `xrpl_signMessage`
 * traite `message` comme de l'hex (ripple-keypairs.sign) → on encode le challenge en hex.
 */
export async function signMessageEmbedded(
  message: string,
): Promise<{ signature: string; publicKey: string }> {
  const w3a = await getWeb3Auth();
  const provider = w3a.getConnector(WALLET_CONNECTORS.AUTH)?.provider;
  if (!provider) throw new Error("Wallet embarqué indisponible");

  const publicKey = await provider.request<never, string>({ method: "xrpl_getPublicKey" });
  const res = await provider.request<{ message: string }, { signature: string }>({
    method: "xrpl_signMessage",
    params: { message: toHex(message) },
  });
  if (!publicKey || !res?.signature) throw new Error("Signature embarquée échouée");
  return { signature: res.signature, publicKey };
}

/**
 * Signe une transaction XRPL avec la clé embarquée → tx_blob. `xrpl_signTransaction`
 * appelle `wallet.sign()` sans autofill : la tx doit déjà être préparée (côté serveur).
 */
export async function signTransactionEmbedded(transaction: object): Promise<string> {
  const w3a = await getWeb3Auth();
  const provider = w3a.getConnector(WALLET_CONNECTORS.AUTH)?.provider;
  if (!provider) throw new Error("Wallet embarqué indisponible");

  const res = await provider.request<{ transaction: object }, { tx_blob: string }>({
    method: "xrpl_signTransaction",
    params: { transaction },
  });
  if (!res?.tx_blob) throw new Error("Signature de transaction embarquée échouée");
  return res.tx_blob;
}
