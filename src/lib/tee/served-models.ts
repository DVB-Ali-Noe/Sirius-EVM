import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decrypt, deriveKey, encrypt, getMasterKey, type EncryptedPayload } from "@/lib/crypto/encryption";
import { parseDeliveredModel, type DeliveredModel } from "@/lib/models/registry";
import { canonicalSubject } from "@/lib/subject";
import { AppError } from "@/lib/app-error";
import { DAY_MS, RENTAL_GRACE_DAYS } from "@/lib/billing/rental";
import { MODEL_REF_ID_PATTERN, modelRefString, type ModelRef } from "./contract";
import { quantizeModel } from "./output-gate";
import { clearLoanCredits } from "@/lib/runner/prediction-usage";

const MAX_SEALED_BYTES = 512 * 1024;
const MAX_INDEX_BYTES = 4 * 1024;
const MODEL_SUFFIX = ".enc";
const INDEX_SUFFIX = ".loan";
const API_KEYS_SUFFIX = ".keys";
const RENTAL_GRACE_MS = RENTAL_GRACE_DAYS * DAY_MS;

/** Message unique d'un modèle de prêt purgé (ou purgeable) : aucune prolongation possible. */
export const DELETED_LOAN_MODEL = "Modèle supprimé : location close";

/**
 * Modèles scellés dans le volume privé du runner : aucun ne sort, ni fichier ni clé. Ils ne
 * s'utilisent que par l'opération `predict`. Propriétaire : celui du job (self-train) ou
 * l'emprunteur (prêt).
 *
 * Location (D-29) : le modèle d'un prêt porte son échéance `expiresAt` (ms epoch), fixée par le
 * runner depuis le bloc du `release` et repoussée par chaque prolongation. Absente : jamais
 * d'échéance (self-train, prêt hérité). Un index `<empreinte>.loan` (chiffré, identifiant du prêt
 * seul) permet à la purge de retrouver ces modèles sans connaître leur référence.
 */
export interface ServedModel {
  owner: string;
  model: DeliveredModel;
  expiresAt?: number;
}

/** Payload chiffré : `extensions` garde l'échéance obtenue par chaque prêt de prolongation (idempotence). */
interface SealedPayload extends ServedModel {
  extensions?: Record<string, number>;
}

function refString(ref: ModelRef): string {
  if ((ref.kind !== "job" && ref.kind !== "loan") || !MODEL_REF_ID_PATTERN.test(ref.id)) {
    throw new AppError("Identifiant de modèle invalide", 400);
  }
  return modelRefString(ref);
}

function privateDirectory(): string {
  const directory = process.env.RUNNER_SERVED_MODELS_DIR;
  if (!directory || !isAbsolute(directory)) throw new AppError("Répertoire de modèles privés indisponible", 503);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new AppError("Répertoire de modèles privés invalide", 503);
  }
  return directory;
}

function refDigest(ref: ModelRef): string {
  return createHash("sha256").update(refString(ref)).digest("hex");
}

function servedPath(ref: ModelRef): string {
  const name = refDigest(ref);
  return join(privateDirectory(), `${name}${MODEL_SUFFIX}`);
}

function indexPath(ref: ModelRef): string {
  const name = refDigest(ref);
  return join(privateDirectory(), `${name}${INDEX_SUFFIX}`);
}

/**
 * Clés API d'un prêt (api-keys.ts) : même volume, même empreinte que son modèle, supprimées avec
 * lui à la purge de la location.
 */
export function loanApiKeysPath(loanId: string): string {
  return join(privateDirectory(), `${refDigest({ kind: "loan", id: loanId })}${API_KEYS_SUFFIX}`);
}

function key(ref: ModelRef): Buffer {
  return deriveKey(getMasterKey(), `model:served:v2:${refString(ref)}`);
}

function indexKey(): Buffer {
  return deriveKey(getMasterKey(), "model:served:index:v1");
}

/** Fichier privé du volume : régulier, lien unique, 0600, au runner, borné ; `null` s'il n'existe pas. */
export function readPrivateFile(path: string, maximum: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
      || stat.size > maximum || stat.size === 0) throw new AppError("Modèle privé invalide", 503);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(): void {
  const directory = openSync(process.env.RUNNER_SERVED_MODELS_DIR!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Écriture durable : fichier temporaire synchronisé, puis lien (création seule) ou renommage (remplacement). */
export function writePrivateFile(path: string, payload: Buffer, replace: boolean): void {
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      for (let written = 0; written < payload.length;) written += writeSync(fd, payload, written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally {
    if (!replace || existsSync(temporary)) unlinkSync(temporary);
  }
  syncDirectory();
}

function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readSealed(ref: ModelRef): SealedPayload | null {
  const path = servedPath(ref);
  try {
    const bytes = readPrivateFile(path, MAX_SEALED_BYTES);
    if (!bytes) return null;
    const sealed = JSON.parse(bytes.toString("utf8")) as EncryptedPayload;
    const data = JSON.parse(decrypt(sealed, key(ref)).toString()) as Record<string, unknown>;
    if (typeof data.owner !== "string" || !/^0x[0-9a-f]{40}$/.test(data.owner)) throw new Error("Propriétaire invalide");
    const payload: SealedPayload = { owner: data.owner, model: parseDeliveredModel(data.model) };
    if (data.expiresAt !== undefined) {
      if (ref.kind !== "loan" || !Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) <= 0) throw new Error("Échéance invalide");
      payload.expiresAt = data.expiresAt as number;
    }
    if (data.extensions !== undefined) {
      const extensions = data.extensions as Record<string, unknown>;
      if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)
        || Object.values(extensions).some((value) => !Number.isSafeInteger(value))) throw new Error("Prolongations invalides");
      payload.extensions = extensions as Record<string, number>;
    }
    return payload;
  } catch {
    throw new AppError("Modèle privé indisponible", 503);
  }
}

function sealedBytes(ref: ModelRef, payload: SealedPayload): Buffer {
  const bytes = Buffer.from(JSON.stringify(encrypt(Buffer.from(JSON.stringify(payload)), key(ref))));
  if (bytes.length > MAX_SEALED_BYTES) throw new AppError("Modèle privé trop volumineux", 413);
  return bytes;
}

/**
 * Empreinte publique du modèle produit : `sm1` + SHA-256 hexadécimal du JSON canonique du modèle
 * après output-gate (67 caractères ; `quantizeModel` est idempotent et fixe l'ordre des champs). Elle remplace l'ancien CID IPFS dans les champs `modelCid`
 * (DB, reçus, attestation), qui gardent le sens « modèle produit » sans désigner aucun fichier.
 */
export function servedModelFingerprint(model: DeliveredModel): string {
  return `sm1${createHash("sha256").update(JSON.stringify(quantizeModel(model))).digest("hex")}`;
}

/**
 * Un prêt ne se règle (et ne se reprend) que si son modèle est scellé ici, à l'emprunteur, sous
 * l'empreinte du reçu : sinon le fournisseur serait payé pour un modèle que `predict` ne servira
 * jamais (prêt entraîné avant la suppression de la livraison). Il reste remboursable à l'échéance.
 */
export function hasSealedLoanModel(loanId: string, borrower: string, fingerprint: string): boolean {
  const sealed = loadServedModel({ kind: "loan", id: loanId });
  return !!sealed && sealed.owner === canonicalSubject(borrower) && servedModelFingerprint(sealed.model) === fingerprint;
}

export function loadServedModel(ref: ModelRef): ServedModel | null {
  const sealed = readSealed(ref);
  if (!sealed) return null;
  return { owner: sealed.owner, model: sealed.model, ...(sealed.expiresAt === undefined ? {} : { expiresAt: sealed.expiresAt }) };
}

export function saveServedModel(ref: ModelRef, owner: string, model: DeliveredModel): void {
  writePrivateFile(servedPath(ref), sealedBytes(ref, { owner: canonicalSubject(owner), model }), false);
}

/** Index de purge d'un modèle de prêt : créé avant la première échéance, jamais modifié ensuite. */
function ensureLoanIndex(ref: ModelRef): void {
  const path = indexPath(ref);
  if (existsSync(path)) return;
  const bytes = Buffer.from(JSON.stringify(encrypt(Buffer.from(JSON.stringify({ loanId: ref.id })), indexKey())));
  try {
    writePrivateFile(path, bytes, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Lecture, calcul et réécriture synchrones : aucune autre requête du runner ne s'intercale entre
 * la lecture de l'échéance et son remplacement.
 */
function rewriteLoanRental(loanId: string, next: (current: SealedPayload) => SealedPayload | null): SealedPayload {
  const ref: ModelRef = { kind: "loan", id: loanId };
  const current = readSealed(ref);
  if (!current) throw new AppError(DELETED_LOAN_MODEL, 409);
  const updated = next(current);
  if (!updated) return current;
  ensureLoanIndex(ref);
  writePrivateFile(servedPath(ref), sealedBytes(ref, updated), true);
  return updated;
}

/**
 * Première échéance d'un prêt réglé (release vérifié). Déjà fixée : inchangée, prolongations
 * comprises. Renvoie l'échéance en vigueur.
 */
export function recordLoanExpiry(loanId: string, expiresAt: number): number {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new AppError("Échéance de location invalide", 500);
  const rental = rewriteLoanRental(loanId, (current) => current.expiresAt === undefined ? { ...current, expiresAt } : null);
  return rental.expiresAt!;
}

/** Modèle de prêt encore prolongeable : présent et pas encore au-delà du délai de grâce. */
export function extendableLoanModel(loanId: string, now = Date.now()): ServedModel & { expiresAt: number } {
  const sealed = loadServedModel({ kind: "loan", id: loanId });
  if (!sealed || (sealed.expiresAt !== undefined && sealed.expiresAt + RENTAL_GRACE_MS <= now)) {
    throw new AppError(DELETED_LOAN_MODEL, 409);
  }
  if (sealed.expiresAt === undefined) throw new AppError("Échéance de location inconnue", 409);
  return sealed as ServedModel & { expiresAt: number };
}

/**
 * Prolongation réglée (release du prêt de prolongation confirmé à `releasedAtMs`) :
 * `expiresAt = max(expiresAt, releasedAtMs) + rentalDays jours`. Idempotente par prêt de
 * prolongation : un rejeu ne prolonge pas deux fois. Renvoie l'échéance en vigueur.
 */
export function extendLoanRental(originalLoanId: string, extensionLoanId: string, releasedAtMs: number, rentalDays: number, now = Date.now()): number {
  const rental = rewriteLoanRental(originalLoanId, (current) => {
    if (current.extensions && Object.hasOwn(current.extensions, extensionLoanId)) return null;
    if (current.expiresAt === undefined) throw new AppError("Échéance de location inconnue", 409);
    if (current.expiresAt + RENTAL_GRACE_MS <= now) throw new AppError(DELETED_LOAN_MODEL, 409);
    const expiresAt = Math.max(current.expiresAt, releasedAtMs) + rentalDays * DAY_MS;
    return { ...current, expiresAt, extensions: { ...current.extensions, [extensionLoanId]: expiresAt } };
  });
  return rental.expiresAt!;
}

export function deleteServedModel(ref: ModelRef): void {
  const removed = unlinkIfPresent(servedPath(ref));
  const indexed = ref.kind === "loan" && unlinkIfPresent(indexPath(ref));
  const keys = ref.kind === "loan" && unlinkIfPresent(loanApiKeysPath(ref.id));
  if (removed || indexed || keys) syncDirectory();
}

/**
 * Purge des locations closes : supprime les modèles de prêt dont `expiresAt + RENTAL_GRACE_DAYS`
 * est atteint. Seuls les modèles indexés (prêts à échéance) sont examinés : un self-train ou un
 * prêt hérité n'est jamais supprimé. Un index illisible est signalé et laissé en place. Renvoie
 * le nombre de modèles supprimés.
 */
export function sweepExpiredLoanModels(now = Date.now()): number {
  const directory = privateDirectory();
  let deleted = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(INDEX_SUFFIX)) continue;
    const digest = name.slice(0, -INDEX_SUFFIX.length);
    let ref: ModelRef;
    try {
      const bytes = readPrivateFile(join(directory, name), MAX_INDEX_BYTES);
      if (!bytes) continue;
      const { loanId } = JSON.parse(decrypt(JSON.parse(bytes.toString("utf8")) as EncryptedPayload, indexKey()).toString()) as { loanId?: unknown };
      if (typeof loanId !== "string") throw new Error("Index invalide");
      ref = { kind: "loan", id: loanId };
      if (refDigest(ref) !== digest) throw new Error("Index hors scope");
    } catch {
      console.warn("[served-models] index de location illisible : ignoré par la purge");
      continue;
    }
    let sealed: SealedPayload | null;
    try {
      sealed = readSealed(ref);
    } catch {
      console.warn("[served-models] modèle de prêt illisible : ignoré par la purge");
      continue;
    }
    if (sealed && (sealed.expiresAt === undefined || sealed.expiresAt + RENTAL_GRACE_MS > now)) continue;
    // Crédits de packs perdus avec le modèle (D-30), effacés d'abord : un échec laisse le modèle
    // en place pour la purge suivante, jamais un modèle supprimé avec des crédits restants.
    try {
      clearLoanCredits(ref.id);
    } catch {
      console.warn("[served-models] crédits d'appels non effacés : modèle gardé jusqu'à la purge suivante");
      continue;
    }
    deleteServedModel(ref);
    if (sealed) deleted++;
  }
  return deleted;
}
