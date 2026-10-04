import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { prisma, serializableTransaction } from "@/lib/db";
import { AppError } from "@/lib/app-error";
import { normalizeAddress, type CanonicalAddress } from "@/lib/evm/address";

/**
 * Profil d'un wallet : tutos, réglages, cache KYB et blocage côté site.
 *
 * Règles de sécurité de ce module :
 *   - l'adresse vient toujours de la session, jamais d'un corps de requête, et elle est
 *     normalisée en minuscules avant toute lecture ou écriture (une casse divergente
 *     créerait deux profils pour un même wallet) ;
 *   - l'API publique ne modifie que `tourCompletedAt`, `featureTours` et `settings` ; le
 *     KYB et le blocage sont posés par l'admin ou le contrat, et une tentative de les
 *     modifier ici est refusée, pas ignorée ;
 *   - les JSON reçus sont bornés en taille et validés clé par clé, puis re-filtrés à la
 *     lecture : une ligne altérée en base ne remonte jamais de clé inconnue au client ;
 *   - la vue renvoyée n'expose ni `blockedReason` ni `blockedBy` (notes internes de
 *     l'admin), seulement la date de blocage.
 */

/** Pages dotées d'un tuto ([02](../../../docs/passage-mainnet/02-general.md)). Liste fermée. */
export const FEATURE_TOUR_KEYS = ["dashboard", "datasets", "upload", "marketplace", "train", "explorer", "wallet"] as const;
export type FeatureTourKey = (typeof FEATURE_TOUR_KEYS)[number];

/** Langues de l'interface : anglais seul au lancement, le français viendra après. */
export const PROFILE_LANGUAGES = ["en"] as const;
export type ProfileLanguage = (typeof PROFILE_LANGUAGES)[number];

/** Taille maximale, en caractères JSON, d'une modification de profil. */
export const MAX_PROFILE_PATCH_CHARS = 2_048;

/** Bornes des champs du journal des accès : identifiants cuid, CID IPFS et empreintes hexadécimales. */
const MAX_ID_CHARS = 64;
const MAX_CID_CHARS = 256;
const MAX_FINGERPRINT_CHARS = 128;
const TOKEN_PATTERN = /^[A-Za-z0-9:_.-]+$/;

export type FeatureTours = Partial<Record<FeatureTourKey, boolean>>;
export interface ProfileSettings {
  language?: ProfileLanguage;
  sidebarCollapsed?: boolean;
}

/** Modification acceptée par l'API : tout le reste est refusé. */
export interface UserProfilePatch {
  /** Booléen côté API : `true` pose la date côté serveur, `false` l'efface. */
  tourCompletedAt?: boolean;
  featureTours?: FeatureTours;
  settings?: ProfileSettings;
}

/** Vue renvoyée au wallet connecté, sérialisable telle quelle en JSON. */
export interface UserProfileView {
  address: CanonicalAddress;
  tourCompletedAt: string | null;
  featureTours: FeatureTours;
  settings: ProfileSettings;
  kybStatus: string | null;
  kybCheckedAt: string | null;
  blockedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** Colonnes lues d'une ligne `UserProfile` ; la ligne Prisma s'y conforme, les tests aussi. */
export interface UserProfileRow {
  address: string;
  tourCompletedAt: Date | null;
  featureTours: unknown;
  settings: unknown;
  kybStatus: string | null;
  kybCheckedAt: Date | null;
  blockedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/** Client Prisma ou transaction : la même fonction sert hors et dans une transaction. */
type Db = Pick<Prisma.TransactionClient, "userProfile" | "datasetAccessLog">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Ne garde que les tutos connus avec une valeur booléenne : une ligne altérée reste lisible. */
export function sanitizeFeatureTours(value: unknown): FeatureTours {
  const tours: FeatureTours = {};
  if (!isPlainObject(value)) return tours;
  for (const key of FEATURE_TOUR_KEYS) {
    if (Object.hasOwn(value, key) && typeof value[key] === "boolean") tours[key] = value[key] as boolean;
  }
  return tours;
}

/** Ne garde que les réglages connus et bien typés. */
export function sanitizeSettings(value: unknown): ProfileSettings {
  const settings: ProfileSettings = {};
  if (!isPlainObject(value)) return settings;
  if (Object.hasOwn(value, "language") && (PROFILE_LANGUAGES as readonly unknown[]).includes(value.language)) {
    settings.language = value.language as ProfileLanguage;
  }
  if (Object.hasOwn(value, "sidebarCollapsed") && typeof value.sidebarCollapsed === "boolean") {
    settings.sidebarCollapsed = value.sidebarCollapsed;
  }
  return settings;
}

/** Normalise l'adresse d'un profil ou lève une 400 : minuscules, 20 octets hexadécimaux. */
export function normalizeProfileAddress(address: unknown): CanonicalAddress {
  return normalizeAddress(address, "adresse du profil");
}

function validateFeatureTours(value: unknown): FeatureTours {
  if (!isPlainObject(value)) throw new AppError("Tutos de profil invalides", 400);
  const tours: FeatureTours = {};
  for (const key of Object.keys(value)) {
    if (!(FEATURE_TOUR_KEYS as readonly string[]).includes(key)) throw new AppError("Tuto de profil inconnu", 400);
    if (typeof value[key] !== "boolean") throw new AppError("Tutos de profil invalides", 400);
    tours[key as FeatureTourKey] = value[key] as boolean;
  }
  return tours;
}

function validateSettings(value: unknown): ProfileSettings {
  if (!isPlainObject(value)) throw new AppError("Réglages de profil invalides", 400);
  const settings: ProfileSettings = {};
  for (const key of Object.keys(value)) {
    if (key === "language") {
      if (!(PROFILE_LANGUAGES as readonly unknown[]).includes(value.language)) {
        throw new AppError("Langue non prise en charge", 400);
      }
      settings.language = value.language as ProfileLanguage;
    } else if (key === "sidebarCollapsed") {
      if (typeof value.sidebarCollapsed !== "boolean") throw new AppError("Réglages de profil invalides", 400);
      settings.sidebarCollapsed = value.sidebarCollapsed;
    } else {
      throw new AppError("Réglage de profil inconnu", 400);
    }
  }
  return settings;
}

/**
 * Valide strictement une modification de profil. Toute clé hors `tourCompletedAt`,
 * `featureTours` et `settings` est refusée (400), y compris `address`, `kybStatus` et
 * les champs de blocage : l'API ne les ignore pas silencieusement pour qu'un client qui
 * tenterait de les écrire s'en aperçoive. Une modification vide est refusée aussi.
 */
export function validateProfilePatch(input: unknown): UserProfilePatch {
  if (!isPlainObject(input)) throw new AppError("Modification de profil invalide", 400);
  if (JSON.stringify(input).length > MAX_PROFILE_PATCH_CHARS) {
    throw new AppError("Modification de profil trop volumineuse", 413);
  }
  const patch: UserProfilePatch = {};
  for (const key of Object.keys(input)) {
    if (key === "tourCompletedAt") {
      if (typeof input.tourCompletedAt !== "boolean") throw new AppError("Modification de profil invalide", 400);
      patch.tourCompletedAt = input.tourCompletedAt;
    } else if (key === "featureTours") {
      patch.featureTours = validateFeatureTours(input.featureTours);
    } else if (key === "settings") {
      patch.settings = validateSettings(input.settings);
    } else {
      throw new AppError("Champ de profil non modifiable", 400);
    }
  }
  if (Object.keys(patch).length === 0) throw new AppError("Aucune modification de profil", 400);
  return patch;
}

/** Vue publique d'une ligne : dates en ISO 8601, JSON re-filtrés, notes admin exclues. */
export function toUserProfileView(row: UserProfileRow): UserProfileView {
  return {
    address: normalizeProfileAddress(row.address),
    tourCompletedAt: row.tourCompletedAt?.toISOString() ?? null,
    featureTours: sanitizeFeatureTours(row.featureTours),
    settings: sanitizeSettings(row.settings),
    kybStatus: row.kybStatus,
    kybCheckedAt: row.kybCheckedAt?.toISOString() ?? null,
    blockedAt: row.blockedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Crée le profil s'il n'existe pas et date le passage. `createdAt` est posé avec la même
 * horloge que `lastSeenAt` : une ligne ne naît jamais « vue » avant d'exister.
 *
 * Sur PostgreSQL, Prisma compile cet upsert en `INSERT … ON CONFLICT DO UPDATE`, atomique :
 * deux premières connexions simultanées ne lèvent pas de P2002. La reprise ci-dessous est
 * une ceinture pour le cas où Prisma retomberait sur le chemin non natif (autre moteur,
 * écriture imbriquée) ; elle ne boucle jamais.
 */
export async function ensureUserProfile(address: unknown, db: Db = prisma): Promise<UserProfileView> {
  const canonical = normalizeProfileAddress(address);
  const now = new Date();
  const upsert = () => db.userProfile.upsert({
    where: { address: canonical },
    create: { address: canonical, createdAt: now, lastSeenAt: now },
    update: { lastSeenAt: now },
  });
  try {
    return toUserProfileView(await upsert());
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return toUserProfileView(await upsert());
  }
}

/** Lit le profil sans le créer ni le dater ; `null` s'il n'existe pas encore. */
export async function readUserProfile(address: unknown, db: Db = prisma): Promise<UserProfileView | null> {
  const row = await db.userProfile.findUnique({ where: { address: normalizeProfileAddress(address) } });
  return row ? toUserProfileView(row) : null;
}

/**
 * Applique une modification validée. `featureTours` et `settings` sont fusionnés clé par
 * clé avec l'existant, dans une transaction sérialisable : deux pages qui marquent leur
 * tuto en même temps ne s'effacent pas l'une l'autre. Le profil est créé s'il manque
 * (session ouverte avant la migration) par un upsert : une création concurrente entre la
 * lecture et l'écriture (connexion dans un autre onglet) ne lève pas de violation d'unicité.
 */
export async function updateUserProfile(
  address: unknown,
  input: unknown,
  transaction: <T>(action: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> = serializableTransaction,
): Promise<UserProfileView> {
  const canonical = normalizeProfileAddress(address);
  const patch = validateProfilePatch(input);
  const now = new Date();
  const row = await transaction(async (tx) => {
    const existing = await tx.userProfile.findUnique({ where: { address: canonical } });
    const data: Prisma.UserProfileUncheckedUpdateInput = { lastSeenAt: now };
    if (patch.tourCompletedAt !== undefined) {
      data.tourCompletedAt = patch.tourCompletedAt ? (existing?.tourCompletedAt ?? now) : null;
    }
    if (patch.featureTours) {
      data.featureTours = { ...sanitizeFeatureTours(existing?.featureTours), ...patch.featureTours };
    }
    if (patch.settings) {
      data.settings = { ...sanitizeSettings(existing?.settings), ...patch.settings };
    }
    if (existing) return tx.userProfile.update({ where: { address: canonical }, data });
    return tx.userProfile.upsert({
      where: { address: canonical },
      create: { ...(data as Omit<Prisma.UserProfileUncheckedCreateInput, "address">), address: canonical, createdAt: now },
      update: data,
    });
  });
  return toUserProfileView(row);
}

/** Attente maximale du profil à la connexion : au-delà, la connexion continue sans lui. */
export const LOGIN_PROFILE_TIMEOUT_MS = 2_000;

/**
 * Mises à jour de profil encore en vol depuis la route de connexion, au-delà desquelles on
 * n'en lance plus : une base qui ne répond pas ne doit jamais monopoliser le pool (cinq
 * connexions par instance) depuis cette seule route. Compteur par instance.
 */
export const MAX_IN_FLIGHT_LOGIN_TOUCHES = 2;
let inFlightLoginTouches = 0;

/** Client capable d'ouvrir une transaction interactive ; les stubs de test peuvent s'en passer. */
type LoginDb = Db & Partial<Pick<typeof prisma, "$transaction">>;

/**
 * Après une connexion réussie : crée ou date le profil sans jamais faire échouer ni
 * suspendre la connexion.
 *
 *   - une base qui répond par une erreur est rattrapée ;
 *   - une base qui ne répond pas (verrou, bascule) est abandonnée après `timeoutMs`, et la
 *     requête elle-même porte `lock_timeout` et `statement_timeout` du même ordre, posés dans
 *     une transaction courte, pour que PostgreSQL l'annule et rende la connexion au pool ;
 *   - au-delà de `MAX_IN_FLIGHT_LOGIN_TOUCHES` mises à jour encore en vol, on n'en lance
 *     pas de nouvelle.
 *
 * Seule la classe de l'erreur est journalisée, jamais l'adresse ni la cause, qui peut
 * contenir une chaîne de connexion.
 */
export async function touchUserProfileAfterLogin(
  address: unknown,
  db: LoginDb = prisma,
  timeoutMs = LOGIN_PROFILE_TIMEOUT_MS,
): Promise<void> {
  if (inFlightLoginTouches >= MAX_IN_FLIGHT_LOGIN_TOUCHES) {
    console.warn("[auth] profil utilisateur non mis à jour (ProfileSkipped)");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProfileTimeoutError()), timeoutMs);
  });
  inFlightLoginTouches += 1;
  const touch = ensureUserProfileWithin(address, db, timeoutMs).finally(() => { inFlightLoginTouches -= 1; });
  try {
    await Promise.race([touch, expired]);
  } catch (error) {
    console.warn(`[auth] profil utilisateur non mis à jour (${error instanceof Error ? error.name : typeof error})`);
  } finally {
    clearTimeout(timer);
    // La promesse abandonnée est tenue : son rejet éventuel ne doit pas rester sans gestionnaire.
    touch.catch(() => {});
  }
}

/** Upsert sous délais PostgreSQL : un verrou ou un serveur lent rend la connexion au lieu de la garder. */
async function ensureUserProfileWithin(address: unknown, db: LoginDb, timeoutMs: number): Promise<UserProfileView> {
  if (!db.$transaction) return ensureUserProfile(address, db);
  const budget = Math.max(1, Math.floor(timeoutMs));
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${budget}`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${budget}`);
    return ensureUserProfile(address, tx);
  });
}

class ProfileTimeoutError extends Error {
  constructor() {
    super("délai dépassé");
    this.name = "ProfileTimeout";
  }
}

export interface DatasetAccessEntry {
  datasetId: string;
  address: string;
  loanId?: string | null;
  modelCid?: string | null;
  modelFingerprint?: string | null;
}

export interface DatasetAccessRecord {
  id: string;
  datasetId: string;
  address: CanonicalAddress;
  loanId: string | null;
  modelCid: string | null;
  modelFingerprint: string | null;
  createdAt: Date;
}

function requireToken(value: unknown, maxChars: number, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars || !TOKEN_PATTERN.test(value)) {
    throw new AppError(message, 400);
  }
  return value;
}

function optionalToken(value: unknown, maxChars: number, message: string): string | null {
  if (value === undefined || value === null) return null;
  return requireToken(value, maxChars, message);
}

/**
 * Journal des accès : qui a reçu quel modèle pour quel dataset et quel prêt. À appeler
 * au moment de la livraison du modèle, dans la même transaction que la livraison quand
 * c'est possible (`db` accepte une transaction). Un dataset inconnu est refusé en 404 par
 * la clé étrangère. Pas encore branché sur la livraison.
 */
export async function recordDatasetAccess(entry: DatasetAccessEntry, db: Db = prisma): Promise<DatasetAccessRecord> {
  if (!isPlainObject(entry)) throw new AppError("Entrée du journal des accès invalide", 400);
  const data = {
    datasetId: requireToken(entry.datasetId, MAX_ID_CHARS, "Entrée du journal des accès invalide"),
    address: normalizeAddress(entry.address, "adresse du journal des accès"),
    loanId: optionalToken(entry.loanId, MAX_ID_CHARS, "Entrée du journal des accès invalide"),
    modelCid: optionalToken(entry.modelCid, MAX_CID_CHARS, "Entrée du journal des accès invalide"),
    modelFingerprint: optionalToken(entry.modelFingerprint, MAX_FINGERPRINT_CHARS, "Entrée du journal des accès invalide"),
  };
  let row: Awaited<ReturnType<typeof db.datasetAccessLog.create>>;
  try {
    row = await db.datasetAccessLog.create({ data });
  } catch (error) {
    // Clé étrangère : le dataset n'existe pas (ou plus). Message métier plutôt qu'un 500 opaque.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new AppError("Dataset introuvable", 404);
    }
    throw error;
  }
  return {
    id: row.id,
    datasetId: row.datasetId,
    address: data.address,
    loanId: row.loanId,
    modelCid: row.modelCid,
    modelFingerprint: row.modelFingerprint,
    createdAt: row.createdAt,
  };
}
