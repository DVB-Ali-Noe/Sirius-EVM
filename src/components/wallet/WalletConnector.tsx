"use client";

import { useEffect } from "react";
import { clearWalletDisconnected, walletDisconnectedByUser } from "@/lib/wallet/intent";
import { invalidateWalletSession } from "@/lib/auth/client";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { EVM_CHAIN_IDS, resolveClientNetwork, type EvmNetwork } from "@/lib/evm/networks";
import { connectExternalWallet, getExternalWallet } from "@/lib/wallet/manager";
import { useWalletStore } from "@/stores/wallet";

function networkForChain(chainId: unknown): string {
  if (typeof chainId !== "string") return "unknown";
  const parsed = Number.parseInt(chainId, 16);
  return (Object.entries(EVM_CHAIN_IDS).find(([, id]) => id === parsed)?.[0] as EvmNetwork | undefined) ?? chainId;
}

export function openWalletModal(): void {
  // Clic explicite sur « Connecter » : on lève l'intention de déconnexion, sinon la
  // synchronisation continuerait de refuser le compte que l'utilisateur vient de
  // rouvrir, et le bouton semblerait ne rien faire.
  clearWalletDisconnected();
  void connectExternalWallet().then(({ address, chainId }) => {
    const normalized = tryNormalizeAddress(address);
    if (!normalized) throw new Error("Adresse EVM invalide.");
    const current = useWalletStore.getState();
    if (current.address !== normalized || current.source !== "external") void invalidateWalletSession();
    useWalletStore.getState().setConnected(normalized, networkForChain(chainId), "external");
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
      const current = useWalletStore.getState();
      if (current.address !== address || current.source !== "external") void invalidateWalletSession();
      setConnected(address, networkForChain(chainId), "external");
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
      const current = useWalletStore.getState();
      if (current.address !== address || current.source !== "external") void invalidateWalletSession();
      void wallet.request({ method: "eth_chainId" }).then((chainId) => setConnected(address, networkForChain(chainId), "external"));
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
