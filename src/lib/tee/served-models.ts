import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decrypt, deriveKey, encrypt, getMasterKey, type EncryptedPayload } from "@/lib/crypto/encryption";
import { parseDeliveredModel, type DeliveredModel } from "@/lib/models/registry";
import { canonicalSubject } from "@/lib/subject";
import { AppError } from "@/lib/app-error";
import { MODEL_REF_ID_PATTERN, modelRefString, type ModelRef } from "./contract";
import { quantizeModel } from "./output-gate";

const MAX_SEALED_BYTES = 512 * 1024;

/**
 * Modèles scellés dans le volume privé du runner : aucun ne sort, ni fichier ni clé. Ils ne
 * s'utilisent que par l'opération `predict`. Propriétaire : celui du job (self-train) ou
 * l'emprunteur (prêt).
 */
function refString(ref: ModelRef): string {
  if ((ref.kind !== "job" && ref.kind !== "loan") || !MODEL_REF_ID_PATTERN.test(ref.id)) {
    throw new AppError("Identifiant de modèle invalide", 400);
  }
  return modelRefString(ref);
}

function servedPath(ref: ModelRef): string {
  const name = refString(ref);
  const directory = process.env.RUNNER_SERVED_MODELS_DIR;
  if (!directory || !isAbsolute(directory)) throw new AppError("Répertoire de modèles privés indisponible", 503);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new AppError("Répertoire de modèles privés invalide", 503);
  }
  return join(directory, `${createHash("sha256").update(name).digest("hex")}.enc`);
}

function key(ref: ModelRef): Buffer {
  return deriveKey(getMasterKey(), `model:served:v2:${refString(ref)}`);
}

/**
 * Empreinte publique du modèle produit : `sm1` + SHA-256 hexadécimal du JSON canonique du modèle
 * après output-gate (67 caractères ; `quantizeModel` est idempotent et fixe l'ordre des champs). Elle remplace l'ancien CID IPFS dans les champs `modelCid`
 * (DB, reçus, attestation), qui gardent le sens « modèle produit » sans désigner aucun fichier.
 */
export function servedModelFingerprint(model: DeliveredModel): string {
  return `sm1${createHash("sha256").update(JSON.stringify(quantizeModel(model))).digest("hex")}`;
}

export function loadServedModel(ref: ModelRef): { owner: string; model: DeliveredModel } | null {
  const path = servedPath(ref);
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
      || stat.size > MAX_SEALED_BYTES || stat.size === 0) throw new AppError("Modèle privé invalide", 503);
    const sealed = JSON.parse(readFileSync(fd, "utf8")) as EncryptedPayload;
    const data = JSON.parse(decrypt(sealed, key(ref)).toString()) as { owner?: unknown; model?: unknown };
    if (typeof data.owner !== "string" || !/^0x[0-9a-f]{40}$/.test(data.owner)) throw new Error("Propriétaire invalide");
    return { owner: data.owner, model: parseDeliveredModel(data.model) };
  } catch {
    throw new AppError("Modèle privé indisponible", 503);
  } finally {
    closeSync(fd);
  }
}

export function saveServedModel(ref: ModelRef, owner: string, model: DeliveredModel): void {
  const path = servedPath(ref);
  const payload = Buffer.from(JSON.stringify(encrypt(Buffer.from(JSON.stringify({ owner: canonicalSubject(owner), model })), key(ref))));
  if (payload.length > MAX_SEALED_BYTES) throw new AppError("Modèle privé trop volumineux", 413);
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      for (let written = 0; written < payload.length;) written += writeSync(fd, payload, written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
  const directory = openSync(process.env.RUNNER_SERVED_MODELS_DIR!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
