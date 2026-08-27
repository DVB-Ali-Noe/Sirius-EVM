"use client";

/**
 * Approvisionnement du compte connecté.
 *
 * Sur une instance de démonstration, « ajouter des fonds » veut dire frapper des
 * jetons de test : le réseau est un testnet et le jeton a une frappe ouverte. Aucun
 * service d'achat par carte ne vend cette monnaie-là, et il serait absurde d'en
 * chercher un.
 *
 * Sur une instance réelle, la même intention passe par MoonPay, d'où le repli. La
 * fenêtre y est ouverte après l'appel réseau, ce qui peut la faire bloquer sur Safari
 * — compromis assumé : le chemin de démonstration est celui qui sert aujourd'hui, et
 * il ne doit pas ouvrir de fenêtre parasite à chaque clic.
 */

export interface FondsAjoutes {
  usdc: string;
  eth: string | null;
  usdcTxHash: string;
}

export async function addFunds(): Promise<FondsAjoutes> {
  const response = await fetch("/api/faucet", { method: "POST" });
  const body = await response.json().catch(() => ({}));

  if (response.ok) return body as FondsAjoutes;

  // 503 : pas une instance de démonstration. On tente l'achat réel.
  if (response.status === 503) {
    const onramp = await fetch("/api/onramp");
    const urlBody = await onramp.json().catch(() => ({}));
    if (onramp.ok && typeof urlBody.url === "string") {
      window.open(urlBody.url, "moonpay", "popup,width=460,height=720");
      throw new Error("Fenêtre d'achat ouverte");
    }
  }

  throw new Error(typeof body.error === "string" ? body.error : "Ajout de fonds indisponible");
}
