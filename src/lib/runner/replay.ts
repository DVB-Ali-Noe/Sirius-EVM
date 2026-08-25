import "server-only";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const memoryReplay = new Map<string, number>();
const MAX_REPLAY_TTL_MS = 2 * 60 * 60_000;
let cleanupCounter = 0;

function cleanupMemory(now: number): void {
  for (const [id, expiry] of memoryReplay) {
    if (expiry <= now) memoryReplay.delete(id);
  }
}

function cleanupDirectory(directory: string, now: number): void {
  for (const name of readdirSync(directory)) {
    const match = /^[a-f0-9]{64}$/.test(name);
    let expiry = 0;
    try {
      expiry = match ? Number(readFileSync(join(directory, name), "utf8")) : 0;
    } catch {}
    if (!match || !Number.isSafeInteger(expiry) || expiry <= now || expiry > now + MAX_REPLAY_TTL_MS) {
      try {
        unlinkSync(join(directory, name));
      } catch {}
    }
  }
}

/**
 * Force l'écriture de l'entrée de répertoire sur le disque.
 *
 * POSIX impose un `fsync` du répertoire pour qu'une création de fichier survive à une
 * coupure d'alimentation : sans lui, le contenu peut être sur le disque alors que
 * l'entrée qui le nomme est perdue. Windows n'expose pas cette opération — y ouvrir un
 * répertoire pour le synchroniser échoue avec `EPERM`.
 *
 * L'étanchéité de l'anti-rejeu ne repose pas sur ce `fsync` : elle vient du drapeau
 * `wx`, dont l'atomicité est garantie par le système de fichiers. Ce qu'on perd sous
 * Windows est donc la seule durabilité après coupure brutale, sur une plateforme qui
 * ne sert qu'au développement — la production tourne sous Linux, dans l'enclave.
 *
 * L'échec n'est toléré que là où l'opération n'existe pas. Ailleurs il remonte, car il
 * signalerait une vraie perte de durabilité.
 */
function syncDirectory(directory: string): void {
  const tolerable = process.platform === "win32";
  let descriptor: number;
  try {
    descriptor = openSync(directory, "r");
  } catch (error) {
    if (tolerable) return;
    throw error;
  }
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!tolerable) throw error;
  } finally {
    closeSync(descriptor);
  }
}

export function consumeRunnerReplay(namespace: "capability" | "grant", id: string, expiresAt: number): boolean {
  const now = Date.now();
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_REPLAY_TTL_MS ||
    !id ||
    id.length > 512
  ) {
    return false;
  }

  const root = process.env.RUNNER_REPLAY_DIR?.trim();
  const replayId = `${namespace}:${id}`;
  if (!root) {
    cleanupMemory(now);
    if (memoryReplay.has(replayId)) return false;
    memoryReplay.set(replayId, expiresAt);
    return true;
  }

  const directory = join(root, namespace);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (cleanupCounter++ % 64 === 0) cleanupDirectory(directory, now);

  const digest = createHash("sha256").update(replayId).digest("hex");
  try {
    const descriptor = openSync(join(directory, digest), "wx", 0o600);
    try {
      writeSync(descriptor, String(expiresAt));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(directory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
