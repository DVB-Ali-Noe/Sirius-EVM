import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { consumeRunnerReplay } from "./replay";

let replayDirectory: string | undefined;

afterEach(() => {
  delete process.env.RUNNER_REPLAY_DIR;
  if (replayDirectory) rmSync(replayDirectory, { recursive: true, force: true });
  replayDirectory = undefined;
});

test("l’anti-rejeu persiste hors mémoire du process", () => {
  replayDirectory = mkdtempSync(join(tmpdir(), "sirius-replay-"));
  process.env.RUNNER_REPLAY_DIR = replayDirectory;
  const expiry = Date.now() + 60_000;

  assert.equal(consumeRunnerReplay("capability", "nonce-1", expiry), true);
  assert.equal(consumeRunnerReplay("capability", "nonce-1", expiry), false);
  assert.equal(consumeRunnerReplay("capability", "nonce-1", expiry + 1_000), false);
  assert.equal(consumeRunnerReplay("grant", "nonce-1", expiry), true);
});

test("refuse les expirations non entières ou hors borne", () => {
  const now = Date.now();
  assert.equal(consumeRunnerReplay("grant", "nonce-2", Number.NaN), false);
  assert.equal(consumeRunnerReplay("grant", "nonce-3", now + 3 * 60 * 60_000), false);
  assert.equal(consumeRunnerReplay("grant", "", now + 60_000), false);
});
