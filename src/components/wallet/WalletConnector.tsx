"use client";

import { useEffect } from "react";
import { clearWalletDisconnected, walletDisconnectedByUser } from "@/lib/wallet/intent";
import { invalidateWalletSession } from "@/lib/auth/client";
import { hasRunnerDelegation } from "@/lib/runner/authorization-client";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { EVM_CHAIN_IDS, resolveClientNetwork, type EvmNetwork } from "@/lib/evm/networks";
import { connectExternalWallet, getExternalWallet } from "@/lib/wallet/manager";
import { useWalletStore } from "@/stores/wallet";

function networkForChain(chainId: unknown): string {
  if (typeof chainId !== "string") return "unknown";
  const parsed = Number.parseInt(chainId, 16);
  return (Object.entries(EVM_CHAIN_IDS).find(([, id]) => id === parsed)?.[0] as EvmNetwork | undefined) ?? chainId;
}

/**
 * Aligne l'état du navigateur sur la session que le serveur reconnaît.
 *
 * Le store wallet ne persiste pas — c'est délibéré, il doit refléter le provider
 * vivant — mais le cookie de session, lui, dure sept jours. Au montage, le
 * store est donc vide face à une session encore ouverte, et la divergence ressemblait
 * à s'y méprendre à un changement de compte : on détruisait la session à chaque
 * navigation. L'utilisateur signait, changeait de page, et se retrouvait déconnecté
 * sans qu'aucun message ne l'explique.
 *
 * C'est le serveur qui tranche, puisque c'est lui qui détient le cookie. Trois cas :
 * une session pour cette adresse, on se déclare authentifié ; une session pour une
 * autre adresse, vestige d'un compte précédent, on la ferme ; aucune session, il n'y
 * a rien à faire et l'utilisateur signera.
 */
async function synchroniserSession(address: string): Promise<void> {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) return;
    const { authenticated, address: sessionAddress } = (await response.json()) as {
      authenticated?: unknown;
      address?: unknown;
    };
    if (authenticated !== true) return;

    if (tryNormalizeAddress(sessionAddress) !== address) {
      void invalidateWalletSession();
      return;
    }
    const delegationReady = await hasRunnerDelegation(address, useWalletStore.getState().network);
    // Le compte a pu changer pendant l'aller-retour réseau.
    if (useWalletStore.getState().address === address) {
      useWalletStore.getState().setAuthenticated(delegationReady);
    }
  } catch {
    // Serveur injoignable : on reste non authentifié plutôt que de l'affirmer à tort.
    // L'utilisateur peut toujours signer, ce qui rétablira l'état.
  }
}

export function openWalletModal(): void {
  // Clic explicite sur « Connecter » : on lève l'intention de déconnexion, sinon la
  // synchronisation continuerait de refuser le compte que l'utilisateur vient de
  // rouvrir, et le bouton semblerait ne rien faire.
  clearWalletDisconnected();
  void connectExternalWallet().then(({ address, chainId }) => {
    const normalized = tryNormalizeAddress(address);
    if (!normalized) throw new Error("Adresse EVM invalide.");
    useWalletStore.getState().setConnected(normalized, networkForChain(chainId), "external");
    void synchroniserSession(normalized);
  }).catch((error) => console.error("Connexion wallet EVM échouée", error));
}

export function WalletConnector() {
  const setConnected = useWalletStore((state) => state.setConnected);
  const setDisconnected = useWalletStore((state) => state.setDisconnected);
  const setNetwork = useWalletStore((state) => state.setNetwork);

  useEffect(() => {
    const wallet = getExternalWallet();
    if (!wallet) return;
    let active = true;
    const sync = async () => {
      // L'utilisateur s'est déconnecté : le portefeuille reste peut-être autorisé,
      // mais le reconnecter d'office annulerait son geste sous ses yeux.
      if (walletDisconnectedByUser()) return;
      const [accounts, chainId] = await Promise.all([
        wallet.request({ method: "eth_accounts" }),
        wallet.request({ method: "eth_chainId" }),
      ]);
      if (!active || !Array.isArray(accounts) || typeof accounts[0] !== "string") return;
      const address = tryNormalizeAddress(accounts[0]);
      if (!address) return;
      setConnected(address, networkForChain(chainId), "external");
      void synchroniserSession(address);
    };
    const onAccountsChanged = (accounts: unknown) => {
      // Un changement de compte est un geste délibéré : il vaut demande de connexion.
      clearWalletDisconnected();
      const address = tryNormalizeAddress(Array.isArray(accounts) ? accounts[0] : undefined);
      if (!address) {
        void invalidateWalletSession();
        setDisconnected();
        return;
      }
      void wallet.request({ method: "eth_chainId" }).then((chainId) => {
        setConnected(address, networkForChain(chainId), "external");
        void synchroniserSession(address);
      });
    };
    const onChainChanged = (chainId: unknown) => {
      void invalidateWalletSession();
      setNetwork(networkForChain(chainId));
    };
    wallet.on?.("accountsChanged", onAccountsChanged);
    wallet.on?.("chainChanged", onChainChanged);
    void sync();
    return () => {
      active = false;
      wallet.removeListener?.("accountsChanged", onAccountsChanged);
      wallet.removeListener?.("chainChanged", onChainChanged);
    };
  }, [setConnected, setDisconnected, setNetwork]);

  return null;
}

export const EXPECTED_EVM_NETWORK = resolveClientNetwork();
