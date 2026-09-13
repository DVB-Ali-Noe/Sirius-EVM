"use client";

import type { Eip1193Provider } from "@/lib/wallet/manager";

/**
 * Découverte des portefeuilles installés, selon EIP-6963.
 *
 * `window.ethereum` est un emplacement unique que plusieurs extensions se disputent :
 * celle qui s'injecte en dernier l'emporte, presque toujours MetaMask. Un utilisateur
 * qui a Phantom et MetaMask se voit donc proposer MetaMask sans qu'on lui demande
 * rien, et son autre portefeuille reste invisible pour le site.
 *
 * EIP-6963 remplace ce point de contention par une annonce : le site demande, chaque
 * portefeuille se signale avec son nom et son icône, et le choix revient à
 * l'utilisateur.
 *
 * Un portefeuille peut répondre après le premier appel — l'extension n'est pas
 * forcément prête au chargement de la page. On écoute donc en permanence, et on
 * redemande à chaque interrogation.
 */

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface AnnouncedWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

const CLE_CHOIX = "sirius.wallet.rdns";

const decouverts = new Map<string, AnnouncedWallet>();
let ecouteDemarree = false;
let choixSession: string | null | undefined;
const abonnements = new Set<() => void>();

function notifier(): void {
  for (const abonnement of abonnements) abonnement();
}

export function subscribeWalletChanges(listener: () => void): () => void {
  abonnements.add(listener);
  detectedWallets();
  return () => { abonnements.delete(listener); };
}

function demarrerEcoute(): void {
  if (ecouteDemarree || typeof window === "undefined") return;
  ecouteDemarree = true;
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<AnnouncedWallet>).detail;
    // L'annonce vient d'une extension tierce : on ne fait confiance ni à sa forme ni
    // à sa complétude, d'où les vérifications malgré ce que promet le type.
    if (typeof detail?.info?.rdns === "string" && typeof detail.provider?.request === "function") {
      const previous = decouverts.get(detail.info.rdns)?.provider;
      decouverts.set(detail.info.rdns, detail);
      if (previous !== detail.provider) notifier();
    }
  });
}

/** Redemande aux portefeuilles de se signaler et rend ceux qui ont répondu. */
export function detectedWallets(): WalletInfo[] {
  if (typeof window === "undefined") return [];
  demarrerEcoute();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return [...decouverts.values()].map((w) => w.info);
}

/**
 * Attend que les portefeuilles se signalent.
 *
 * L'annonce est synchrone côté extension mais passe par la boucle d'événements : sans
 * ce délai, la première interrogation revient systématiquement vide et l'utilisateur
 * verrait « aucun portefeuille détecté » alors qu'il en a trois.
 */
export async function waitForWallets(delaiMs = 300): Promise<WalletInfo[]> {
  detectedWallets();
  await new Promise((resolve) => setTimeout(resolve, delaiMs));
  return detectedWallets();
}

export function selectedWalletRdns(): string | null {
  if (choixSession !== undefined) return choixSession;
  try {
    return window.localStorage.getItem(CLE_CHOIX);
  } catch {
    return null;
  }
}

export function selectWallet(rdns: string): void {
  choixSession = rdns;
  try {
    window.localStorage.setItem(CLE_CHOIX, rdns);
  } catch {
    // Stockage indisponible : le choix ne survivra pas au rechargement, mais il doit
    // valoir pour la session en cours plutôt que faire échouer la connexion.
  }
  notifier();
}

export function clearSelectedWallet(): void {
  choixSession = null;
  try {
    window.localStorage.removeItem(CLE_CHOIX);
  } catch {
    // Voir ci-dessus.
  }
  notifier();
}

/**
 * Portefeuille à utiliser : celui que l'utilisateur a choisi, sinon rien.
 *
 * On ne devine pas à sa place quand plusieurs sont installés — c'est précisément le
 * comportement qu'EIP-6963 existe pour corriger.
 */
export function selectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const rdns = selectedWalletRdns();
  if (!rdns) return null;

  const connu = decouverts.get(rdns)?.provider;
  if (connu) return connu;

  // Rien en mémoire. Le cas est courant et n'a rien d'anormal : la découverte n'était
  // déclenchée que par le bouton « Connecter », donc au premier rendu d'une page
  // atteinte directement — un rechargement du tableau de bord, un lien partagé — la
  // table restait vide. On retombait alors sur `window.ethereum`, c'est-à-dire sur
  // l'extension qui a gagné la course à l'injection plutôt que sur celle que
  // l'utilisateur a choisie, et les lectures partaient vers un autre réseau.
  //
  // Redemander suffit : l'annonce est synchrone chez la plupart des portefeuilles.
  // Pour les autres, l'écoute reste posée et le prochain appel aboutira.
  detectedWallets();
  return decouverts.get(rdns)?.provider ?? null;
}

// Certaines extensions s'annoncent d'elles-mêmes au chargement, sans qu'on demande
// rien, et ne le répètent pas. Poser l'écoute dès l'import plutôt qu'au premier appel
// évite de manquer cette annonce-là.
demarrerEcoute();
