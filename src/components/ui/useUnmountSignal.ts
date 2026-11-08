"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Signal coupé au démontage du composant : une attente de l'enclave (`retryWhileEnclaveStarts`) ou
 * un envoi lancé depuis ce composant s'arrête quand la page le quitte, au lieu de relancer seul une
 * requête (un devis périmé remplacerait sinon le PENDING d'un autre emprunt). Un contrôleur par
 * montage : le double montage de développement (StrictMode) n'en laisse pas un déjà coupé.
 */
export function useUnmountSignal(): () => AbortSignal {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const current = controller.current ?? new AbortController();
    controller.current = current;
    return () => {
      current.abort();
      if (controller.current === current) controller.current = null;
    };
  }, []);
  return useCallback(() => (controller.current ??= new AbortController()).signal, []);
}
