import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TOUR_PAGE_KEYS } from "../../lib/tour/keys";

/**
 * Rend la fenêtre des tutos dans un processus sans la condition `react-server` (voir
 * `tour-dialog.render.tsx`) puis vérifie le HTML : rôle, liens d'accessibilité, boutons,
 * textes et absence de HTML injecté. Le piège du focus et Échap, qui demandent un vrai
 * DOM, sont décrits dans docs/passage-mainnet/audit.md (section A3, essais manuels).
 */
const script = fileURLToPath(new URL("./tour-dialog.render.tsx", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const child = spawnSync(process.execPath, ["--import", "tsx", script], {
  cwd: root, env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
});
assert.equal(child.status, 0, `le rendu a échoué : ${child.stderr}`);
const html = JSON.parse(child.stdout) as Record<string, string>;

function page(name: string): string {
  assert.ok(Object.hasOwn(html, name), `cas absent : ${name}`);
  return html[name];
}

function assertAccessibleDialog(out: string, name: string) {
  assert.match(out, /role="dialog"/, name);
  assert.match(out, /aria-modal="true"/, name);
  const labelledBy = out.match(/aria-labelledby="([^"]+)"/)?.[1];
  const describedBy = out.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(labelledBy && out.includes(`<h2 id="${labelledBy}"`), `${name} : titre relié`);
  assert.ok(describedBy && out.includes(`id="${describedBy}"`), `${name} : texte relié`);
  assert.notEqual(labelledBy, describedBy);
  // Tous les boutons sont de vrais boutons, jamais des soumissions de formulaire.
  for (const button of out.match(/<button[^>]*>/g) ?? []) assert.match(button, /type="button"/, name);
  assert.doesNotMatch(out, /<script|dangerouslySetInnerHTML|target="_blank"/, name);
}

test("tuto d'accueil : fenêtre accessible, première étape, Passer et Suivant", () => {
  const out = page("welcome");
  assertAccessibleDialog(out, "welcome");
  assert.match(out, /Guided tour · Step 1 \/ 6/);
  assert.match(out, /<h2 [^>]*>Welcome to Sirius<\/h2>/);
  assert.match(out, /Sirius lets you train a model on confidential data/);
  assert.match(out, />Skip</);
  assert.match(out, />Next</);
  assert.doesNotMatch(out, />Previous</, "pas de retour à la première étape");
  // Points de progression décoratifs, masqués aux lecteurs d'écran.
  assert.match(out, /<div aria-hidden="true" class="mt-5 flex/);
});

test("dernière étape : contact cliquable, bouton de fin, pas de Passer", () => {
  const out = page("welcome-last");
  assert.match(out, /<h2 [^>]*>Need more\?<\/h2>/);
  assert.match(out, /Need a stronger model or specific data\? Contact us at <a href="mailto:sirius\.data\.contact@gmail\.com"/);
  assert.equal(out.match(/href=/g)?.length, 1);
  assert.match(out, />Got it</, "une seule étape : bouton « Got it »");
  assert.doesNotMatch(out, />Skip</);
});

test("étape des limites de la bêta : textes communs, sans paragraphe vide", () => {
  const out = page("welcome-beta");
  assert.match(out, /Sirius currently trains baseline models: linear and logistic regression on tabular data\./);
  assert.match(out, /Beta: instant on-chain wallet verification, capped amounts per loan and in total\./);
  assert.doesNotMatch(out, /<p><\/p>/);
  // La description reliée contient les textes communs, pas un bloc vide.
  const describedBy = out.match(/aria-describedby="([^"]+)"/)?.[1];
  const description = out.slice(out.indexOf(`id="${describedBy}"`));
  assert.match(description.slice(0, description.indexOf("<button")), /Beta: instant on-chain wallet verification/);
});

test("tutos de page : un par page, accessibles, un seul bouton de fermeture", () => {
  for (const key of TOUR_PAGE_KEYS) {
    const out = page(`page-${key}`);
    assertAccessibleDialog(out, key);
    assert.match(out, /Page guide/);
    assert.doesNotMatch(out, /Step \d/, `${key} : une seule étape, pas de compteur`);
    assert.equal(out.match(/<button/g)?.length, 1, key);
    assert.match(out, />Got it</);
  }
});

test("tuto d'upload : limites des données lues dans le code, contact", () => {
  const out = page("page-upload");
  assert.match(out, /CSV up to 3 MB, 100 to 20,000 rows, numeric columns, up to 31 input features\./);
  assert.match(out, /mailto:sirius\.data\.contact@gmail\.com/);
  assert.match(out, /<li>The dataset can only be borrowed once it is published\.<\/li>/);
});

test("tuto du wallet : section Limites en liste", () => {
  const out = page("page-wallet");
  assert.match(out, /<h3[^>]*>Limits<\/h3><ul[^>]*><li>Amounts credited in the escrow only reach your wallet once you withdraw them\./);
  assert.doesNotMatch(out, /destination address|any address/, "aucun retrait vers une adresse tierce n'existe");
  assert.doesNotMatch(out, /mailto:/);
});

test("liste d'étapes vide : rien n'est rendu, sans exception", () => {
  assert.equal(page("empty-steps"), "");
});

test("rendu serveur : ni fenêtre ni bouton « ? » (pas d'écart d'hydratation, rien de bloquant)", () => {
  assert.equal(page("server-product-tour"), "");
  assert.equal(page("server-page-tour"), "");
});
