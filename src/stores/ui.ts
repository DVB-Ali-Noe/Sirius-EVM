import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Préférences UI contextuelles. `advanced` pilote le niveau de détail (Simple/Avancé,
 * D-19/D-23) : config d'entraînement + blocs de détails on-chain. Défaut Simple,
 * mémorisé en localStorage (par device). Pas de tier de compte.
 */
interface UiState {
  advanced: boolean;
  setAdvanced: (advanced: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      advanced: false,
      setAdvanced: (advanced) => set({ advanced }),
    }),
    { name: "sirius-ui", skipHydration: true },
  ),
);
