import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decrypt, deriveKey, encrypt, getMasterKey, type EncryptedPayload } from "@/lib/crypto/encryption";
import { parseDeliveredModel, type GradientBoostedTreesModel } from "@/lib/models/registry";
import { canonicalSubject } from "@/lib/subject";
import { AppError } from "@/lib/app-error";

const MAX_SEALED_BYTES = 512 * 1024;

function servedPath(jobId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new AppError("Identifiant de modèle invalide", 400);
  const directory = process.env.RUNNER_SERVED_MODELS_DIR;
  if (!directory || !isAbsolute(directory)) throw new AppError("Répertoire de modèles privés indisponible", 503);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new AppError("Répertoire de modèles privés invalide", 503);
  }
  return join(directory, `${createHash("sha256").update(jobId).digest("hex")}.enc`);
}

function key(jobId: string): Buffer {
  return deriveKey(getMasterKey(), `model:served:v1:${jobId}`);
}

export function loadServedModel(jobId: string): { owner: string; model: GradientBoostedTreesModel } | null {
  const path = servedPath(jobId);
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
    const data = JSON.parse(decrypt(sealed, key(jobId)).toString()) as { owner?: unknown; model?: unknown };
    if (typeof data.owner !== "string" || !/^0x[0-9a-f]{40}$/.test(data.owner)) throw new Error("Propriétaire invalide");
    const model = parseDeliveredModel(data.model);
    if (model.algo !== "gradient_boosted_trees" || model.version !== "1.1.0") throw new Error("Profil servi invalide");
    return { owner: data.owner, model };
  } catch {
    throw new AppError("Modèle privé indisponible", 503);
  } finally {
    closeSync(fd);
  }
}

export function saveServedModel(jobId: string, owner: string, model: GradientBoostedTreesModel): void {
  const path = servedPath(jobId);
  const payload = Buffer.from(JSON.stringify(encrypt(Buffer.from(JSON.stringify({ owner: canonicalSubject(owner), model })), key(jobId))));
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
