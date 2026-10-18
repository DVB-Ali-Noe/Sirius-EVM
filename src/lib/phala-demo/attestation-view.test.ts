import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/** Rend la page dans un processus sans `react-server` (voir `attestation-view.render.tsx`). */
const script = fileURLToPath(new URL("./attestation-view.render.tsx", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const child = spawnSync(process.execPath, ["--import", "tsx", script], {
  cwd: root,
  env: { ...process.env, NODE_OPTIONS: "" },
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: 120_000,
});
assert.equal(child.status, 0, `le rendu a échoué : ${child.stderr}`);
const html = JSON.parse(child.stdout) as Record<string, string>;

function page(name: string): string {
  assert.ok(Object.hasOwn(html, name), `cas absent : ${name}`);
  return html[name];
}

const state = (out: string, label: string) => out.match(new RegExp(`data-value="${label}" data-state="([a-z]+)"`))?.[1];

test("vue vérifiée : quatre maillons, MRTD de la quote, aucun lien vers le dépôt privé", () => {
  for (const name of ["declared", "proven", "provenWithoutCommit", "unlisted"]) {
    const out = page(name);
    assert.match(out, /data-verdict="verified"/);
    for (const link of ["Intel chip", "Machine", "Code", "Connection"]) assert.ok(out.includes(`data-link="${link}"`), `${name} ${link}`);
    assert.ok(out.includes("f0".repeat(48)));
    assert.ok(out.includes("61".repeat(32)));
    assert.equal(state(out, "Compose hash"), "verified");
    assert.doesNotMatch(out, /href="https:\/\/github\.com/);
  }
});

test("image déclarée par la table : ni prouvée ni commande de hachage du Compose", () => {
  const out = page("declared");
  assert.equal(state(out, "Runner image"), "declared");
  assert.equal(state(out, "Source commit"), "declared");
  assert.ok(out.includes("712fbb2"));
  assert.doesNotMatch(out, /\.appCompose/);
});

test("image prouvée par le Compose publié : commit toujours déclaré, commande de hachage proposée", () => {
  const out = page("proven");
  assert.equal(state(out, "Runner image"), "verified");
  assert.equal(state(out, "Source commit"), "declared");
  assert.match(out, /jq -j \.appCompose sirius-phala-attestation\.json \| sha256sum/);
  const withoutCommit = page("provenWithoutCommit");
  assert.equal(state(withoutCommit, "Source commit"), "unlisted");
  assert.ok(!withoutCommit.includes("712fbb2"));
});

test("version non répertoriée : seul le hash Compose attesté, jamais une image ou un commit", () => {
  const out = page("unlisted");
  assert.equal(state(out, "Runner image"), "unlisted");
  assert.ok(!out.includes("sirius-runner@sha256"));
  assert.ok(!out.includes("712fbb2"));
  assert.ok(!out.includes('data-value="Source commit"'));
});

test("indisponible et trop de requêtes : aucun verdict vérifié ni empreinte", () => {
  for (const name of ["unavailable", "busy"]) {
    const out = page(name);
    assert.doesNotMatch(out, /data-verdict="verified"/);
    assert.doesNotMatch(out, /data-link=/);
  }
  assert.match(page("unavailable"), /data-verdict="unavailable"/);
});
