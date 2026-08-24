"use client";

import type { WalletManager } from "xrpl-connect";

let managerPromise: Promise<WalletManager> | null = null;

/**
 * WalletManager partagé. xrpl-connect touche `window` à l'import → chargé
 * dynamiquement (navigateur only) pour ne pas casser le SSR.
 *
 * Adapters sans config (extension/device) toujours actifs : Crossmark, GemWallet,
 * Otsu, Xyra, Ledger. Xaman et WalletConnect nécessitent une clé → activés seulement
 * si la variable d'env correspondante est fournie.
 */
export function getWalletManager(): Promise<WalletManager> {
  if (managerPromise) return managerPromise;

  managerPromise = (async () => {
    try {
      const xc = await import("xrpl-connect");

      const adapters: unknown[] = [
        new xc.CrossmarkAdapter(),
        new xc.GemWalletAdapter(),
        new xc.OtsuAdapter(),
        new xc.XyraAdapter(),
        new xc.LedgerAdapter({
          derivationPath: "44'/144'/0'/0/0",
          timeout: 60000,
          preferWebHID: true,
        }),
      ];

      const xamanKey = process.env.NEXT_PUBLIC_XAMAN_API_KEY;
      if (xamanKey) adapters.push(new xc.XamanAdapter({ apiKey: xamanKey }));

      const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
      if (wcProjectId) adapters.push(new xc.WalletConnectAdapter({ projectId: wcProjectId }));

      const network = process.env.NEXT_PUBLIC_XRPL_NETWORK || "testnet";
      return new xc.WalletManager({ adapters, network, autoConnect: true });
    } catch (err) {
      // Permet un retry au prochain appel au lieu de rester bloqué sur une promesse rejetée.
      managerPromise = null;
      throw err;
    }
  })();

  return managerPromise;
}

export async function disconnectWallet(): Promise<void> {
  const manager = await getWalletManager();
  await manager.disconnect();
}

/**
 * Signe le challenge d'auth avec le wallet externe. Format de retour hétérogène selon
 * l'adaptateur : on ne gère que `{ signature, publicKey }` (Crossmark). GemWallet
 * (`signedMessage`) et WalletConnect (non supporté) lèvent une erreur explicite.
 */
export async function signMessageExternal(
  message: string,
): Promise<{ signature: string; publicKey: string }> {
  const manager = await getWalletManager();
  const res = await manager.signMessage(message);
  const signature = res?.signature;
  const publicKey = res?.publicKey || manager.account?.publicKey;
  if (!signature || !publicKey) {
    throw new Error("Ce wallet ne supporte pas la connexion par signature — essaie Crossmark ou Google.");
  }
  return { signature, publicKey };
}

/**
 * Signe une transaction XRPL avec le wallet externe → tx_blob (soumis par le backend).
 * Retour hétérogène selon l'adaptateur ; on couvre les formes connues (Crossmark).
 */
export async function signTransactionExternal(transaction: Record<string, unknown>): Promise<string> {
  const manager = await getWalletManager();
  const signed = (await manager.sign(transaction)) as Record<string, unknown> | undefined;
  const blob = (signed?.tx_blob ?? signed?.txBlob ?? signed?.signedTransaction) as string | undefined;
  if (!blob) {
    throw new Error("Ce wallet ne permet pas de signer la transaction — essaie Crossmark ou Google.");
  }
  return blob;
}
