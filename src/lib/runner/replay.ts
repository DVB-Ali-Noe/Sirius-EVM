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
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
