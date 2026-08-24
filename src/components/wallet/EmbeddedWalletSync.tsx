"use client";

import { useEffect } from "react";
import { CONNECTOR_EVENTS } from "@web3auth/modal";
import { getWeb3Auth, getEmbeddedAddress, getEmbeddedMfaEnabled } from "@/lib/web3auth/manager";
import { useWalletStore } from "@/stores/wallet";
import { invalidateWalletSession } from "@/lib/auth/client";

/**
 * Composant headless : initialise le singleton Web3Auth et synchronise sa session
 * (connect/disconnect) vers le store wallet avec `source: "embedded"`. Pendant
 * xrpl-connect (`WalletConnector`) fait de même avec `source: "external"`.
 */
export function EmbeddedWalletSync() {
  const setConnected = useWalletStore((s) => s.setConnected);
  const setDisconnected = useWalletStore((s) => s.setDisconnected);
  const setMfaEnabled = useWalletStore((s) => s.setMfaEnabled);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const network = process.env.NEXT_PUBLIC_XRPL_NETWORK || "testnet";

    (async () => {
      const w3a = await getWeb3Auth().catch(() => null);
      if (cancelled || !w3a) return;

      // Séquencé : setConnected réinitialise mfaEnabled à false → le fetch MFA doit
      // impérativement venir après, sinon un ordre de résolution défavorable l'écrase.
      const syncConnected = async () => {
        const address = await getEmbeddedAddress().catch(() => null);
        if (address) {
          const current = useWalletStore.getState();
          if (!current.address || current.address !== address || current.source !== "embedded") {
            await invalidateWalletSession();
          }
          if (cancelled) return;
          setConnected(address, network, "embedded");
        }
        setMfaEnabled(await getEmbeddedMfaEnabled().catch(() => false));
      };
      const onDisconnected = () => {
        if (useWalletStore.getState().source === "embedded") {
          void invalidateWalletSession();
          setDisconnected();
        }
      };

      w3a.on(CONNECTOR_EVENTS.CONNECTED, syncConnected);
      w3a.on(CONNECTOR_EVENTS.DISCONNECTED, onDisconnected);
      cleanup = () => {
        w3a.off(CONNECTOR_EVENTS.CONNECTED, syncConnected);
        w3a.off(CONNECTOR_EVENTS.DISCONNECTED, onDisconnected);
      };

      // Session déjà restaurée avant l'attache des listeners.
      if (w3a.connected) syncConnected();
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [setConnected, setDisconnected, setMfaEnabled]);

  return null;
}
