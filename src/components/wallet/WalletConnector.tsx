"use client";

import { useEffect } from "react";
import { clearWalletDisconnected, walletDisconnectedByUser } from "@/lib/wallet/intent";
import { invalidateWalletSession } from "@/lib/auth/client";
import { hasRunnerDelegation } from "@/lib/runner/authorization-client";
import { tryNormalizeAddress } from "@/lib/evm/address";
import { EVM_CHAIN_IDS, resolveClientNetwork, type EvmNetwork } from "@/lib/evm/networks";
import { connectExternalWallet, getExternalWallet } from "@/lib/wallet/manager";
import { EMBEDDED_RDNS, embeddedSelected, selectWallet } from "@/lib/wallet/discovery";
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

/**
 * Ouvre la connexion sociale et adopte le compte obtenu.
 *
 * Le SDK n'est chargé qu'ici, à l'instant du clic : il pèse plusieurs centaines de
 * kilo-octets, et l'immense majorité des visiteurs d'une page publique ne s'en servira
 * jamais. Un import statique l'aurait mis dans le bundle de chaque page.
 *
 * Le choix n'est mémorisé qu'après une connexion réussie. Une fenêtre Google refermée sans
 * rien valider ne doit pas laisser l'application convaincue qu'un portefeuille embarqué est
 * sélectionné — elle refuserait alors l'extension que l'utilisateur voulait peut-être.
 *
 * Côté serveur, la source reste « external » : c'est une EOA qui a signé, et rien dans
 * Sirius n'a besoin de savoir d'où venait sa clé.
 */
export function openEmbeddedWallet(): void {
  clearWalletDisconnected();
  void (async () => {
    const { connectEmbedded } = await import("@/lib/wallet/embedded");
    const { address, chainId } = await connectEmbedded();
    const normalized = tryNormalizeAddress(address);
    if (!normalized) throw new Error("Adresse EVM invalide.");
    selectWallet(EMBEDDED_RDNS);
    useWalletStore.getState().setConnected(normalized, networkForChain(chainId), "external");
    void synchroniserSession(normalized);
  })().catch((error) => console.error("Connexion Google échouée", error));
}

export function WalletConnector() {
  const setConnected = useWalletStore((state) => state.setConnected);
  const setDisconnected = useWalletStore((state) => state.setDisconnected);
  const setNetwork = useWalletStore((state) => state.setNetwork);

  useEffect(() => {
    let active = true;
    let wallet: ReturnType<typeof getExternalWallet> = null;
    const sync = async () => {
      // L'utilisateur s'est déconnecté : le portefeuille reste peut-être autorisé,
      // mais le reconnecter d'office annulerait son geste sous ses yeux.
      if (walletDisconnectedByUser()) return;
      if (!wallet) return;
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
      void wallet?.request({ method: "eth_chainId" }).then((chainId) => {
        setConnected(address, networkForChain(chainId), "external");
        void synchroniserSession(address);
      });
    };
    const onChainChanged = (chainId: unknown) => {
      void invalidateWalletSession();
      setNetwork(networkForChain(chainId));
    };
    // Le portefeuille embarqué garde sa session dans le stockage du navigateur, mais le
    // store ne persiste pas : sans cette reprise, un rechargement ramènerait une page
    // déconnectée alors que la session, elle, est toujours ouverte des deux côtés. On ne
    // charge le SDK que si c'est bien lui que l'utilisateur avait choisi.
    const demarrer = async () => {
      if (embeddedSelected()) {
        const { restoreEmbedded } = await import("@/lib/wallet/embedded");
        await restoreEmbedded();
      }
      if (!active) return;
      wallet = getExternalWallet();
      if (!wallet) return;
      wallet.on?.("accountsChanged", onAccountsChanged);
      wallet.on?.("chainChanged", onChainChanged);
      await sync();
    };
    void demarrer();
    return () => {
      active = false;
      wallet?.removeListener?.("accountsChanged", onAccountsChanged);
      wallet?.removeListener?.("chainChanged", onChainChanged);
    };
  }, [setConnected, setDisconnected, setNetwork]);

  return null;
}

export const EXPECTED_EVM_NETWORK = resolveClientNetwork();
