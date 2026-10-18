import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DECLARED_RELEASES, PUBLISHED_COMPOSES_DIR, resolveCodeRelease, runnerImageFromAppCompose } from "./attestation";

const IMAGE = `ghcr.io/dvb-ali-noe/sirius-runner@sha256:${"78".repeat(32)}`;
const OTHER_IMAGE = `ghcr.io/dvb-ali-noe/sirius-runner@sha256:${"99".repeat(32)}`;
const dir = mkdtempSync(join(tmpdir(), "sirius-composes-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function appCompose(services: Record<string, { image: string }>): Buffer {
  const compose = JSON.stringify({ services });
  return Buffer.from(JSON.stringify({ manifest_version: 2, name: "sirius", runner: "docker-compose", docker_compose_file: compose }));
}

function publish(bytes: Buffer, name = createHash("sha256").update(bytes).digest("hex")): string {
  writeFileSync(join(dir, `${name}.json`), bytes);
  return name;
}

test("fichier publié au hash attesté : image prouvée, commit repris seulement pour la même image", async () => {
  const bytes = appCompose({ runner: { image: IMAGE } });
  const hash = publish(bytes);
  const same = await resolveCodeRelease(hash.toUpperCase(), dir, { [hash]: { image: IMAGE, commit: "712fbb2" } });
  assert.deepEqual(same, { status: "proven", image: IMAGE, commit: "712fbb2", appCompose: bytes.toString("utf8") });
  const other = await resolveCodeRelease(hash, dir, { [hash]: { image: OTHER_IMAGE, commit: "abc1234" } });
  assert.equal(other.status === "proven" && other.commit, null);
});

test("octets modifiés (saut de ligne final) : plus de preuve, repli sur la table ou version non répertoriée", async () => {
  const bytes = appCompose({ runner: { image: IMAGE } });
  const hash = createHash("sha256").update(bytes).digest("hex");
  publish(Buffer.concat([bytes, Buffer.from("\n")]), hash);
  assert.deepEqual(await resolveCodeRelease(hash, dir, { [hash]: { image: OTHER_IMAGE, commit: "abc1234" } }), {
    status: "declared", image: OTHER_IMAGE, commit: "abc1234",
  });
  assert.deepEqual(await resolveCodeRelease(hash, dir, {}), { status: "unlisted" });
});

test("seule l'image du service runner compte, jamais une image d'un autre service", async () => {
  const hash = publish(appCompose({ init: { image: IMAGE } }));
  assert.deepEqual(await resolveCodeRelease(hash, dir, {}), { status: "unlisted" });
  assert.equal(runnerImageFromAppCompose(appCompose({ init: { image: OTHER_IMAGE }, runner: { image: IMAGE } })), IMAGE);
  assert.equal(runnerImageFromAppCompose(appCompose({ runner: { image: "ghcr.io/dvb-ali-noe/sirius-runner:staging" } })), null);
  assert.equal(runnerImageFromAppCompose(Buffer.from('{"docker_compose_file":"services:\\n  runner: {}"}')), null);
});

test("hash absent de composes/ et de la table : aucune image ni commit", async () => {
  assert.deepEqual(await resolveCodeRelease("ab".repeat(32), dir), { status: "unlisted" });
  assert.deepEqual(await resolveCodeRelease("../etc/passwd", dir), { status: "unlisted" });
});

test("composes/ et table publiés : nom = SHA-256 des octets, image runner lisible, digest immuable", () => {
  let files: string[] = [];
  try {
    files = readdirSync(PUBLISHED_COMPOSES_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const file of files) {
    const bytes = readFileSync(join(PUBLISHED_COMPOSES_DIR, file));
    assert.equal(file, `${createHash("sha256").update(bytes).digest("hex")}.json`, file);
    assert.ok(runnerImageFromAppCompose(bytes), file);
  }
  for (const [hash, entry] of Object.entries(DECLARED_RELEASES)) {
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.match(entry.image, /^ghcr\.io\/dvb-ali-noe\/sirius-runner@sha256:[0-9a-f]{64}$/);
    assert.match(entry.commit, /^[0-9a-f]{7,40}$/);
  }
});
