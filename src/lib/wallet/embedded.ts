"use client";

import { Web3Auth } from "@web3auth/modal";
import { WEB3AUTH_NETWORK, CHAIN_NAMESPACES, WALLET_CONNECTORS, AUTH_CONNECTION } from "@web3auth/modal";
import { chainForNetwork, resolveClientNetwork } from "@/lib/evm/networks";
import { registerEmbeddedWallet } from "@/lib/wallet/discovery";
import type { Eip1193Provider } from "@/lib/wallet/manager";

/**
 * Portefeuille embarqué : une EOA dérivée d'une connexion Google.
 *
 * Le reste de l'application parle à un portefeuille par une seule porte — un objet qui
 * répond à `request({ method, params })`. Une extension en est une ; ce module en est une
 * autre, dont la clé est reconstituée dans le navigateur à partir de parts distribuées
 * plutôt que lue dans une extension.
 *
 * Ce qui sort est une signature ECDSA ordinaire de 65 octets. C'est la seule propriété qui
 * compte ici : `recoverWalletAddress` est un `ecrecover` pur, et le runner n'accepte rien
 * d'autre — un compte contractuel (ERC-1271, ERC-4337) authentifierait la connexion mais
 * ne pourrait ni publier, ni entraîner, ni emprunter. D'où une EOA, et pas un smart account.
 *
 * Rien côté serveur ne distingue ce chemin de l'autre, et c'est voulu : il n'y a pas de
 * « session Google » dans Sirius, seulement une adresse qui a signé.
 */

function clientId(): string | null {
  return process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim() || null;
}

/**
 * Réseau du portefeuille embarqué, distinct du réseau EVM.
 *
 * `sapphire_devnet` et `sapphire_mainnet` sont deux dérivations séparées : le même compte
 * Google y produit deux adresses différentes. En changer après coup vide le compte de tous
 * les utilisateurs sans aucune erreur visible — d'où la valeur explicite plutôt qu'un défaut.
 */
function reseauEmbarque() {
  const demande = process.env.NEXT_PUBLIC_WEB3AUTH_NETWORK?.trim();
  return demande === "sapphire_mainnet"
    ? WEB3AUTH_NETWORK.SAPPHIRE_MAINNET
    : WEB3AUTH_NETWORK.SAPPHIRE_DEVNET;
}

/**
 * Configuration de chaîne dérivée de `networks.ts` plutôt que recopiée.
 *
 * Deux descriptions de la même chaîne finiraient par diverger, et la panne serait muette :
 * le portefeuille signerait pour un `chainId` que le serveur n'attend pas, et les
 * délégations seraient rejetées sans que rien n'indique pourquoi.
 */
function chaine() {
  const chain = chainForNetwork(resolveClientNetwork());
  return {
    chainNamespace: CHAIN_NAMESPACES.EIP155,
    chainId: `0x${chain.id.toString(16)}`,
    rpcTarget: chain.rpcUrls.default.http[0],
    displayName: chain.name,
    blockExplorerUrl: chain.blockExplorers?.default.url ?? "",
    ticker: chain.nativeCurrency.symbol,
    tickerName: chain.nativeCurrency.name,
    decimals: chain.nativeCurrency.decimals,
    // Purement décoratif — l'icône de la monnaie dans les écrans du SDK. Exigée par son
    // type, d'où une valeur explicite plutôt qu'une chaîne vide qui afficherait un trou.
    logo: "https://images.toruswallet.io/eth.svg",
  };
}

let instance: Web3Auth | null = null;
let demarrage: Promise<Web3Auth> | null = null;

/**
 * Instance unique, initialisée une seule fois.
 *
 * `init()` ouvre une session et restaure celle du stockage local ; l'appeler deux fois en
 * parallèle — deux composants qui montent ensemble — produit deux sessions concurrentes.
 * La promesse est donc mémorisée, pas seulement l'instance.
 */
async function client(): Promise<Web3Auth> {
  const id = clientId();
  if (!id) throw new Error("Connexion Google indisponible sur cette instance.");
  if (instance) return instance;
  if (demarrage) return demarrage;

  demarrage = (async () => {
    const web3auth = new Web3Auth({
      clientId: id,
      web3AuthNetwork: reseauEmbarque(),
      chains: [chaine()],
      defaultChainId: chaine().chainId,
      // Sans cela, le SDK lance sa propre découverte EIP-6963 et propose les extensions
      // installées. Sirius a déjà la sienne dans `discovery.ts`, et deux sélecteurs
      // concurrents rendraient le portefeuille effectivement utilisé imprévisible.
      multiInjectedProviderDiscovery: false,
    });
    await web3auth.init();
    instance = web3auth;
    return web3auth;
  })();

  try {
    return await demarrage;
  } catch (error) {
    // Un échec d'initialisation ne doit pas condamner la page : sans cette remise à zéro,
    // la promesse rejetée resterait mémorisée et toute tentative ultérieure échouerait
    // avec la première erreur, même si la cause a disparu.
    demarrage = null;
    throw error;
  }
}

/**
 * Ouvre la connexion Google et rend le compte obtenu.
 *
 * On vise directement le connecteur Google plutôt que d'ouvrir le sélecteur du SDK :
 * l'utilisateur a déjà fait ce choix en cliquant « Continuer avec Google », et lui
 * présenter une seconde fenêtre de sélection serait un pas de plus pour rien.
 */
export async function connectEmbedded(): Promise<{ address: string; chainId: string }> {
  const web3auth = await client();
  if (!web3auth.connected) {
    await web3auth.connectTo(WALLET_CONNECTORS.AUTH, { authConnection: AUTH_CONNECTION.GOOGLE });
  }

  const provider = web3auth.provider;
  if (!provider) throw new Error("Connexion Google interrompue.");

  const accounts = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("Aucun compte n’a été créé.");
  }
  const chainId = await provider.request({ method: "eth_chainId" });
  if (typeof chainId !== "string") throw new Error("Réseau EVM indisponible.");

  return { address: accounts[0], chainId };
}

/**
 * Provider du portefeuille embarqué, s'il est connecté.
 *
 * Synchrone et sans effet de bord : `selectedProvider()` est appelé à chaque rendu, et
 * déclencher une initialisation depuis un chemin de lecture ouvrirait une fenêtre de
 * connexion sans que personne ne l'ait demandée.
 */
export function embeddedProvider(): Eip1193Provider | null {
  // La session compte autant que l'objet : après un `logout()`, le SDK peut encore exposer
  // un provider, et le rendre ferait croire à une session ouverte — l'application signerait
  // alors sous une adresse dont l'utilisateur vient de sortir.
  if (!instance?.connected) return null;
  const provider = instance.provider;
  return provider ? (provider as Eip1193Provider) : null;
}

/** Vrai une fois la session sociale ouverte, y compris après restauration au chargement. */
export function embeddedConnected(): boolean {
  return Boolean(instance?.connected);
}

/**
 * Ferme la session sociale.
 *
 * `wallet_revokePermissions` n'existe pas ici : il n'y a aucune permission à retirer à une
 * extension, seulement une session à fermer. Sans cet appel, la déconnexion de Sirius
 * laisserait la session du SDK ouverte et le rechargement suivant reconnecterait tout seul.
 */
export async function disconnectEmbedded(): Promise<void> {
  if (!instance?.connected) return;
  await instance.logout();
}

/**
 * Bascule de chaîne par le SDK plutôt que par le provider.
 *
 * Une extension reçoit `wallet_switchEthereumChain` et peut proposer d'ajouter la chaîne si
 * elle ne la connaît pas. Ici la liste est figée à la configuration : il n'y a rien à
 * ajouter, seulement à désigner laquelle est active.
 */
async function switchEmbeddedChain(chainId: string): Promise<void> {
  const web3auth = await client();
  await web3auth.switchChain({ chainId });
}

/**
 * Identité lisible de l'utilisateur, pour l'afficher à la place d'une adresse hexadécimale.
 *
 * Jamais transmise au serveur ni utilisée pour autoriser quoi que ce soit : l'autorisation
 * passe par la signature, comme pour n'importe quel portefeuille. C'est un confort
 * d'affichage, et il échoue en silence.
 */
export async function embeddedUserEmail(): Promise<string | null> {
  if (!instance?.connected) return null;
  try {
    const info = await instance.getUserInfo();
    return info.email ?? info.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Rouvre la session sociale d'un rechargement de page.
 *
 * Le store du portefeuille ne persiste pas — il doit refléter le provider vivant — alors
 * que le SDK, lui, garde sa session dans le stockage du navigateur. Sans cette reprise,
 * l'utilisateur reviendrait sur une page déconnectée en ayant toujours une session ouverte
 * des deux côtés, et le cookie de Sirius le contredirait.
 *
 * Rend `true` si une session a effectivement été retrouvée. Une absence n'est pas une
 * erreur : c'est le cas normal du premier passage.
 */
export async function restoreEmbedded(): Promise<boolean> {
  if (!clientId()) return false;
  try {
    const web3auth = await client();
    return web3auth.connected;
  } catch {
    // Reprise impossible — réseau coupé, session expirée côté SDK. L'utilisateur reste
    // déconnecté et peut recliquer ; échouer bruyamment ici bloquerait le rendu de la page.
    return false;
  }
}

// Déclaré au chargement du module plutôt qu'après connexion : le lecteur rend `null` tant
// qu'aucune session n'est ouverte, et l'enregistrer tôt évite une fenêtre où le provider
// existe sans que `selectedProvider()` sache le trouver.
registerEmbeddedWallet({
  provider: embeddedProvider,
  switchChain: switchEmbeddedChain,
  logout: disconnectEmbedded,
});
