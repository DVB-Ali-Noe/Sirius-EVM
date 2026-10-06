import "server-only";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { AppError } from "@/lib/app-error";
import { decodeKybInvitation, encodeKybInvitation, invitationSigner, kybAttestationTypedData } from "./invitation";

/**
 * Accès instantané : une invitation KYB signée par le serveur pour le wallet de la session.
 *
 * Le registre reste strict — rien n'y change — mais un second vérificateur, automatique,
 * signe des invitations courtes (30 jours) pour quiconque prouve son wallet par une
 * connexion. Le sujet accepte lui-même on-chain, comme pour un code reçu de l'équipe : la
 * clé ne signe que des messages, n'envoie aucune transaction et n'a besoin d'aucun ETH.
 *
 * Deux interrupteurs, du plus doux au plus radical :
 * - `SIRIUS_KYB_AUTO_INVITE` absent ou différent de « true » : la route répond 404 et plus
 *   aucune invitation n'est émise, dès le redéploiement ; les attestations déjà acceptées
 *   restent valides jusqu'à leur terme (30 jours au plus).
 * - `removeVerifier(<vérificateur automatique>)` par le Safe admin : toutes les
 *   attestations qu'il a émises cessent d'être valides sur-le-champ (`isKybValid` compare
 *   l'époque du vérificateur). C'est la réponse à une clé compromise.
 *
 * La clé vit sur Vercel : volée, elle permet de faire vérifier n'importe quelle adresse,
 * ce qui équivaut à un registre ouvert. Les plafonds ci-dessous bornent le débit d'une
 * telle fuite ; `removeVerifier` l'arrête. Ce module ne journalise ni ne retourne jamais la clé.
 */

export const AUTO_INVITE_FLAG = "SIRIUS_KYB_AUTO_INVITE";
export const AUTO_INVITE_KEY_VARIABLE = "SIRIUS_KYB_AUTO_INVITE_KEY";
export const AUTO_INVITE_MAX_PER_HOUR_VARIABLE = "SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR";
/** Durée de l'attestation signée. Courte à dessein : un abus se périme vite. */
export const AUTO_INVITE_VALIDITY_DAYS = 30;
/** Une attestation encore valide n'est renouvelable que dans ses derniers jours. */
export const AUTO_INVITE_RENEWAL_DAYS = 7;
/** Une invitation signée par wallet et par fenêtre de 24 heures ; la même est reservie entre-temps. */
export const AUTO_INVITE_WALLET_WINDOW_MS = 24 * 60 * 60_000;
export const AUTO_INVITE_GLOBAL_WINDOW_MS = 60 * 60_000;
export const DEFAULT_AUTO_INVITE_MAX_PER_HOUR = 30;
const MAX_AUTO_INVITE_PER_HOUR = 1_000;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const KYB_REGISTRY_VERSION = "sirius-kyb-v3";

export type AutoInviteEnvironment = { readonly [variable: string]: string | undefined };

export interface AutoInviteConfig {
  /** Drapeau exactement « true » ET clé bien formée : sans les deux, la route répond 404. */
  enabled: boolean;
  /** Compte signataire dérivé de la clé ; `null` tant que la fonction n'est pas activée. */
  account: PrivateKeyAccount | null;
  maxPerHour: number;
}

function flagOn(env: AutoInviteEnvironment): boolean {
  return env.SIRIUS_KYB_AUTO_INVITE?.trim() === "true";
}

function keyOf(env: AutoInviteEnvironment): Hex | null {
  const key = env.SIRIUS_KYB_AUTO_INVITE_KEY?.trim() ?? "";
  return PRIVATE_KEY.test(key) ? (key as Hex) : null;
}

function maxPerHourOf(env: AutoInviteEnvironment): number | null {
  const raw = env.SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR?.trim();
  if (!raw) return DEFAULT_AUTO_INVITE_MAX_PER_HOUR;
  if (!/^[1-9][0-9]{0,3}$/.test(raw) || Number(raw) > MAX_AUTO_INVITE_PER_HOUR) return null;
  return Number(raw);
}

/** Lecture bon marché pour l'interface : vrai seulement si le drapeau est posé et la clé bien formée. */
export function autoInviteEnabled(env: AutoInviteEnvironment = process.env): boolean {
  return flagOn(env) && keyOf(env) !== null;
}

export function readAutoInviteConfig(env: AutoInviteEnvironment = process.env): AutoInviteConfig {
  const key = flagOn(env) ? keyOf(env) : null;
  return { enabled: key !== null, account: key ? privateKeyToAccount(key) : null, maxPerHour: maxPerHourOf(env) ?? DEFAULT_AUTO_INVITE_MAX_PER_HOUR };
}

/**
 * Contrôle de démarrage. Refuse de démarrer si le drapeau est posé sans clé valide — une
 * fonction annoncée qui échouerait à chaque clic — ou si la clé est partagée avec le
 * vérificateur de démonstration. Un drapeau absent n'arrête jamais le serveur : c'est
 * l'interrupteur d'urgence, il doit pouvoir être coupé sans rien casser d'autre.
 *
 * Le message retourné ne contient que des noms de variables et l'adresse publique du
 * vérificateur, jamais la clé.
 */
export function autoInviteStartupNotice(env: AutoInviteEnvironment = process.env): string | null {
  const flag = env.SIRIUS_KYB_AUTO_INVITE?.trim();
  if (flag && flag !== "true" && flag !== "false") throw new Error("SIRIUS_KYB_AUTO_INVITE doit valoir true ou false");
  const key = keyOf(env);
  if (maxPerHourOf(env) === null) throw new Error("SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR invalide : entier entre 1 et 1000");
  if (flag !== "true") {
    return env.SIRIUS_KYB_AUTO_INVITE_KEY?.trim()
      ? `[sirius] ${AUTO_INVITE_KEY_VARIABLE} présente sans ${AUTO_INVITE_FLAG}=true : accès instantané KYB fermé, la clé est ignorée (à retirer).`
      : null;
  }
  if (!key) throw new Error("SIRIUS_KYB_AUTO_INVITE=true exige SIRIUS_KYB_AUTO_INVITE_KEY : 0x suivi de 64 caractères hexadécimaux");
  if (env.SIRIUS_KYB_VERIFIER_KEY?.trim().toLowerCase() === key.toLowerCase()) {
    throw new Error("SIRIUS_KYB_AUTO_INVITE_KEY doit être une clé dédiée, distincte du vérificateur KYB de démonstration");
  }
  const { address } = privateKeyToAccount(key);
  return `[sirius] ${AUTO_INVITE_FLAG}=true : accès instantané KYB ouvert, vérificateur automatique ${address}, `
    + `${maxPerHourOf(env)} invitations par heure au plus, 1 par wallet et par 24 h.`;
}

/** Lectures du registre, injectées pour que la logique se teste sans chaîne. */
export interface AutoInviteRegistry {
  version(): Promise<string>;
  isVerifier(verifier: Address): Promise<boolean>;
  verifierEpoch(verifier: Address): Promise<bigint>;
  nonces(subject: Address): Promise<bigint>;
  isKybValid(subject: Address): Promise<boolean>;
  attestationOf(subject: Address): Promise<{ expiresAt: number }>;
}

/**
 * Trace des invitations émises, en base pour tenir d'une instance serverless à l'autre.
 * Les codes ne sont pas des secrets : ils ne valent que pour leur adresse, une fois.
 */
export interface AutoInviteIssuances {
  record(subject: string, code: string, issuedAt: Date, expiresAt: Date): Promise<string>;
  latestForSubjectSince(subject: string, since: Date): Promise<{ code: string } | null>;
  countForSubjectSince(subject: string, since: Date): Promise<number>;
  countSince(since: Date): Promise<number>;
  remove(id: string): Promise<void>;
}

export interface AutoInviteDependencies {
  config: AutoInviteConfig;
  registry: AutoInviteRegistry;
  issuances: AutoInviteIssuances;
  chainId: number;
  registryAddress: Address;
  now?: Date;
  log?: (line: string) => void;
}

export interface AutoInviteResult {
  code: string;
  subject: Address;
  verifier: Address;
  /** Expiration de l'attestation, en secondes Unix. */
  expiresAt: number;
}

/**
 * Émet (ou ressert) l'invitation du wallet de la session. L'adresse vient de la session,
 * jamais d'un corps de requête : c'est l'appelant qui garantit cette provenance.
 *
 * Ordre des refus : fonction fermée (404), registre inattendu ou vérificateur retiré (503,
 * fermé par défaut), KYB déjà valide hors fenêtre de renouvellement (409), plafonds (429).
 */
export async function issueAutoInvitation(subjectRaw: string, deps: AutoInviteDependencies): Promise<AutoInviteResult> {
  const { config, registry, issuances, chainId, registryAddress, now = new Date(), log = console.log } = deps;
  if (!config.enabled || !config.account) throw new AppError("Accès instantané KYB indisponible", 404);
  const verifier = config.account;
  const subject = getAddress(subjectRaw);
  const subjectKey = subject.toLowerCase();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  if (await registry.version() !== KYB_REGISTRY_VERSION) throw new AppError("Migration du registre KYB requise", 503);
  // Le Safe a retiré le vérificateur : on ne signe plus rien, même si le drapeau est resté posé.
  if (!await registry.isVerifier(verifier.address)) {
    throw new AppError("Vérificateur automatique retiré du registre : accès instantané suspendu", 503);
  }
  if (await registry.isKybValid(subject)) {
    const { expiresAt } = await registry.attestationOf(subject);
    if (expiresAt - nowSeconds > AUTO_INVITE_RENEWAL_DAYS * 86_400) {
      throw new AppError("KYB déjà valide : renouvellement possible dans les 7 derniers jours de l’attestation", 409);
    }
  }

  const [epoch, nonce] = await Promise.all([registry.verifierEpoch(verifier.address), registry.nonces(subject)]);
  const walletSince = new Date(now.getTime() - AUTO_INVITE_WALLET_WINDOW_MS);

  // Une transaction refusée dans le wallet ne doit pas coûter 24 heures : tant que le code
  // précédent correspond encore à la chaîne (nonce, époque) et n'est pas près d'expirer,
  // il est resservi tel quel. Sinon, le plafond par wallet s'applique.
  const previous = await issuances.latestForSubjectSince(subjectKey, walletSince);
  if (previous) {
    const reusable = reusableInvitation(previous.code, { subject, verifier: verifier.address, nonce, epoch, nowSeconds });
    if (!reusable) throw new AppError("Une invitation par wallet et par 24 heures", 429);
    log(`[kyb] invitation automatique resservie pour ${subject}, expire le ${new Date(reusable.expiresAt * 1000).toISOString()}`);
    return { code: previous.code, subject, verifier: getAddress(verifier.address), expiresAt: reusable.expiresAt };
  }

  const expiresAt = nowSeconds + AUTO_INVITE_VALIDITY_DAYS * 86_400;
  const fields = {
    chainId, registry: registryAddress, subject, verifier: getAddress(verifier.address),
    expiresAt, nonce: nonce.toString(), verifierEpoch: epoch.toString(),
  };
  const signature = await verifier.signTypedData(kybAttestationTypedData(fields));
  const invitation = { v: 1 as const, ...fields, signature };
  if (getAddress(await invitationSigner(invitation)) !== fields.verifier) throw new AppError("Auto-vérification de la signature échouée", 500);
  const code = encodeKybInvitation(invitation);

  // Inscrit puis compté, comme les essais de code opérateur : en parallèle sur plusieurs
  // instances, la k-ième inscription voit les k − 1 précédentes. Un code refusé n'est jamais
  // retourné et sa trace est retirée, pour ne pas prolonger le blocage.
  const issuance = await issuances.record(subjectKey, code, now, new Date(expiresAt * 1000));
  if (await issuances.countForSubjectSince(subjectKey, walletSince) > 1) {
    await issuances.remove(issuance);
    throw new AppError("Une invitation par wallet et par 24 heures", 429);
  }
  if (await issuances.countSince(new Date(now.getTime() - AUTO_INVITE_GLOBAL_WINDOW_MS)) > config.maxPerHour) {
    await issuances.remove(issuance);
    throw new AppError("Trop de demandes d’accès instantané — réessaie plus tard", 429);
  }
  log(`[kyb] invitation automatique émise pour ${subject}, expire le ${new Date(expiresAt * 1000).toISOString()}`);
  return { code, subject, verifier: fields.verifier, expiresAt };
}

function reusableInvitation(
  code: string,
  current: { subject: Address; verifier: Address; nonce: bigint; epoch: bigint; nowSeconds: number },
): { expiresAt: number } | null {
  try {
    const invitation = decodeKybInvitation(code);
    const fresh = invitation.subject === current.subject && invitation.verifier === getAddress(current.verifier)
      && invitation.nonce === current.nonce.toString() && invitation.verifierEpoch === current.epoch.toString()
      // Même marge que `invitationTransaction` : un code à moins d'une heure du terme serait refusé.
      && invitation.expiresAt > current.nowSeconds + 3600;
    return fresh ? { expiresAt: invitation.expiresAt } : null;
  } catch {
    return null;
  }
}
