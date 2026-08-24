import { create } from "zustand";

export type WalletRole = "provider" | "borrower" | null;
export type WalletSource = "external" | null;

interface WalletState {
  address: string | null;
  network: string | null;
  connected: boolean;
  connecting: boolean;
  role: WalletRole;
  // Origine de la connexion active : wallet EIP-1193 injecté.
  source: WalletSource;
  // Session serveur active (cookie signé) : le wallet a prouvé sa possession par signature.
  authenticated: boolean;
  // Réservé à une future connexion embarquée ; toujours faux pour les wallets externes.
  mfaEnabled: boolean;
  setConnected: (address: string, network: string, source: Exclude<WalletSource, null>) => void;
  setDisconnected: () => void;
  setConnecting: (connecting: boolean) => void;
  setNetwork: (network: string) => void;
  setRole: (role: WalletRole) => void;
  setAuthenticated: (authenticated: boolean) => void;
  setMfaEnabled: (mfaEnabled: boolean) => void;
}

// Pas de persistance : l'état reflète le provider EIP-1193 live.
export const useWalletStore = create<WalletState>((set) => ({
  address: null,
  network: null,
  connected: false,
  connecting: false,
  role: null,
  source: null,
  authenticated: false,
  mfaEnabled: false,
  setConnected: (address, network, source) =>
    // Un nouveau wallet invalide toute session précédente → on repart non authentifié / non sécurisé.
    set({ address, network, source, connected: true, connecting: false, authenticated: false, mfaEnabled: false }),
  setDisconnected: () =>
    set({
      address: null,
      network: null,
      connected: false,
      connecting: false,
      role: null,
      source: null,
      authenticated: false,
      mfaEnabled: false,
    }),
  setConnecting: (connecting) => set({ connecting }),
  setNetwork: (network) => set({ network }),
  setRole: (role) => set({ role }),
  setAuthenticated: (authenticated) => set({ authenticated }),
  setMfaEnabled: (mfaEnabled) => set({ mfaEnabled }),
}));
