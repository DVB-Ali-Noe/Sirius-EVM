"use client";

import { useEffect } from "react";
import { getWalletManager } from "@/lib/wallet/manager";
import { useWalletStore } from "@/stores/wallet";
import { invalidateWalletSession } from "@/lib/auth/client";

const THEME_VARS: Record<string, string> = {
  "--xc-font-family": "var(--font-geist-sans), sans-serif",
  "--xc-primary-color": "#FAFAFA",
  "--xc-background-color": "#131313",
  "--xc-background-secondary": "#1C1C1C",
  "--xc-background-tertiary": "#252525",
  "--xc-text-color": "#E8E8E8",
  "--xc-text-muted-color": "#888888",
  "--xc-danger-color": "#F87171",
  "--xc-success-color": "#34D399",
  "--xc-overlay-background": "rgba(4, 4, 4, 0.62)",
  "--xc-overlay-backdrop-filter": "blur(22px) saturate(130%)",
  "--xc-modal-background": "rgba(19, 19, 19, 0.94)",
  "--xc-modal-border-radius": "2rem",
  "--xc-modal-box-shadow": "0 28px 90px rgba(0, 0, 0, 0.55)",
  "--xc-primary-button-color": "#0B0B0B",
  "--xc-primary-button-background": "#FAFAFA",
  "--xc-primary-button-hover-background": "#E8E8E8",
  "--xc-primary-button-border-radius": "2rem",
  "--xc-secondary-button-background": "#1C1C1C",
  "--xc-secondary-button-hover-background": "#252525",
  "--xc-secondary-button-border-radius": "2rem",
  "--xc-connect-button-border-radius": "2rem",
};

type ConnectorElement = HTMLElement & {
  setWalletManager?: (m: unknown) => void;
  open?: () => void;
  getOverlayRoot?: () => ShadowRoot | null;
};

type AccountLike = { address: string; network?: { id?: string; name?: string } };

let connectorEl: ConnectorElement | null = null;

const OVERLAY_THEME_ID = "sirius-wallet-overlay-theme";

const OVERLAY_THEME = `
  .modal {
    width: 380px;
    border-color: rgba(255, 255, 255, 0.12);
    background: linear-gradient(145deg, rgba(28, 28, 28, 0.98), rgba(13, 13, 13, 0.98));
  }

  .header {
    padding: 24px 24px 4px;
  }

  .title {
    font-size: 22px;
    letter-spacing: -0.04em;
  }

  .close-button {
    width: 36px;
    height: 36px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
  }

  .close-button:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .content {
    padding: 0 24px 24px;
  }

  .error-view {
    gap: 16px;
    padding: 18px 0 0;
  }

  .error-icon {
    width: 60px;
    height: 60px;
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: 2rem;
    background: rgba(248, 113, 113, 0.12);
    box-shadow: 0 12px 30px rgba(248, 113, 113, 0.1);
    color: #f87171;
    font-size: 0;
  }

  .error-icon::after {
    content: "!";
    font-size: 30px;
    font-weight: 600;
  }

  .error-title {
    margin-bottom: 6px;
    font-size: 16px;
    letter-spacing: -0.025em;
  }

  .error-message {
    max-width: 270px;
    font-size: 13px;
    line-height: 1.55;
  }

  .error-buttons {
    gap: 10px;
    margin-top: 6px;
  }

  .error-button {
    padding: 12px 16px;
    border: 1px solid transparent;
    border-radius: 2rem;
    font-size: 14px;
  }

  .error-button-primary {
    background: #fafafa;
    color: #0b0b0b;
    box-shadow: none;
  }

  .error-button-primary:hover {
    background: #e8e8e8;
    color: #0b0b0b;
    box-shadow: none;
  }

  .error-button-secondary {
    border-color: rgba(255, 255, 255, 0.08);
  }
`;

function installOverlayTheme(element: ConnectorElement) {
  let observer: MutationObserver | undefined;

  const inject = () => {
    const root = element.getOverlayRoot?.();
    if (!root?.querySelector(".overlay") || root.getElementById(OVERLAY_THEME_ID)) return;
    const style = document.createElement("style");
    style.id = OVERLAY_THEME_ID;
    style.textContent = OVERLAY_THEME;
    root.append(style);
  };

  const onOpen = () => {
    const root = element.getOverlayRoot?.();
    if (!root || observer) return;
    observer = new MutationObserver(inject);
    observer.observe(root, { childList: true });
    inject();
  };

  element.addEventListener("open", onOpen);

  return () => {
    element.removeEventListener("open", onOpen);
    observer?.disconnect();
  };
}

/** Ouvre le modal de sélection wallet (web-component xrpl-connect). */
export function openWalletModal(): void {
  if (!connectorEl) return;
  if (typeof connectorEl.open === "function") {
    connectorEl.open();
    return;
  }
  connectorEl.shadowRoot?.querySelector("button")?.click();
}

/** Monte le connecteur (caché) et synchronise les events wallet → store. */
export function WalletConnector() {
  const setConnected = useWalletStore((s) => s.setConnected);
  const setDisconnected = useWalletStore((s) => s.setDisconnected);
  const setNetwork = useWalletStore((s) => s.setNetwork);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    let cleanupOverlayTheme: (() => void) | undefined;
    const fallbackNetwork = process.env.NEXT_PUBLIC_XRPL_NETWORK || "testnet";

    (async () => {
      const manager = await getWalletManager().catch(() => null);
      if (cancelled || !manager) return;

      const syncAccount = async (data: unknown) => {
        const acc = data as AccountLike;
        if (acc?.address) {
          const current = useWalletStore.getState();
          if (!current.address || current.address !== acc.address || current.source !== "external") {
            await invalidateWalletSession();
          }
          if (cancelled) return;
          setConnected(
            acc.address,
            acc.network?.id ?? acc.network?.name ?? fallbackNetwork,
            "external",
          );
        }
      };
      // Ne pas écraser une session embedded (Web3Auth) sur un disconnect xrpl-connect.
      const onDisconnect = () => {
        if (useWalletStore.getState().source !== "embedded") {
          void invalidateWalletSession();
          setDisconnected();
        }
      };
      const onNetworkChanged = (data: unknown) => {
        const net = data as { id?: string; name?: string };
        const id = net?.id ?? net?.name;
        if (id) setNetwork(id);
      };

      manager.on("connect", syncAccount);
      manager.on("accountChanged", syncAccount);
      manager.on("disconnect", onDisconnect);
      manager.on("networkChanged", onNetworkChanged);

      // Assigné immédiatement : un démontage pendant l'await ci-dessous doit
      // pouvoir détacher les listeners (sinon fuite sur le singleton).
      cleanup = () => {
        manager.off("connect", syncAccount);
        manager.off("accountChanged", syncAccount);
        manager.off("disconnect", onDisconnect);
        manager.off("networkChanged", onNetworkChanged);
        cleanupOverlayTheme?.();
        connectorEl?.remove();
        connectorEl = null;
      };

      // autoConnect peut avoir reconnecté avant l'attache des listeners.
      if (manager.connected && manager.account) void syncAccount(manager.account);

      const defined = await Promise.race([
        customElements.whenDefined("xrpl-wallet-connector").then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (cancelled || !defined) return;

      const el = document.createElement("xrpl-wallet-connector") as ConnectorElement;
      Object.assign(el.style, {
        position: "absolute",
        opacity: "0",
        pointerEvents: "none",
        width: "0",
        height: "0",
        overflow: "hidden",
      });
      for (const [k, v] of Object.entries(THEME_VARS)) el.style.setProperty(k, v);
      el.setWalletManager?.(manager);
      document.body.appendChild(el);
      cleanupOverlayTheme = installOverlayTheme(el);
      connectorEl = el;
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [setConnected, setDisconnected, setNetwork]);

  return null;
}
