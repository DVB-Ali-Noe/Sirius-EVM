/**
 * Q5 : échoue si une constante de `gbdt.ts` (ou le comportement de l'entraînement) change sans que la version du
 * profil `gradient_boosted_trees` change dans `registry.ts`.
 *
 * Principe : chaque version publiée du profil est figée ici avec (1) toutes les constantes numériques exportées
 * par `gbdt.ts`, relevées automatiquement (une constante ajoutée ou retirée compte aussi), et (2) l'empreinte
 * SHA-256 du modèle livré sur un fichier de référence du dépôt, qui attrape un changement d'algorithme dans
 * `train-gbdt.ts` à constantes égales. Changer le profil impose donc d'incrémenter
 * `MODEL_REGISTRY.gradient_boosted_trees.version` et d'ajouter une entrée ci-dessous ; une version déjà publiée
 * ne peut plus changer de contenu.
 *
 * Lancer : NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/exactitude/tests/profile-version.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import * as gbdt from "@/lib/models/gbdt";
import { MODEL_REGISTRY } from "@/lib/models/registry";
import { gateModel } from "@/lib/tee/output-gate";
import { trainGradientBoostedTrees } from "@/lib/tee/train-gbdt";

type Constants = Record<string, number>;

/** Versions publiées : ne jamais modifier une entrée existante, en ajouter une. */
export const PUBLISHED_PROFILES: Record<string, { constants: Constants; referenceModelSha256: string }> = {
  "1.0.0": {
    constants: {
      GBDT_BINS: 64,
      GBDT_HOLDOUT_EVERY: 5,
      GBDT_L2: 1,
      GBDT_LEARNING_RATE: 0.1,
      GBDT_MAX_DEPTH: 2,
      GBDT_MAX_OPERATIONS: 300_000_000,
      GBDT_MIN_LEAF_ROWS: 1_000,
      GBDT_MIN_ROWS: 10_000,
      GBDT_TREES: 150,
      LEAF_SIG_FIGS: 4,
      THRESHOLD_SIG_FIGS: 3,
    },
    // gateModel(trainGradientBoostedTrees(public/examples/classification/credit-risk-train.csv)).buffer
    referenceModelSha256: "94c88d033420be3bf80afca4d4428d51f08b82be64d4eacb04d9fe5f6a81c865",
  },
};

export function exportedNumericConstants(module: Record<string, unknown>): Constants {
  return Object.fromEntries(
    Object.entries(module).filter(([, value]) => typeof value === "number").sort(([a], [b]) => a.localeCompare(b)),
  ) as Constants;
}

/** `null` si le profil courant correspond à la version déclarée, sinon le motif. */
export function profileMismatch(version: string, constants: Constants, modelSha256: string | null): string | null {
  const published = PUBLISHED_PROFILES[version];
  if (!published) return `version ${version} absente de PUBLISHED_PROFILES : figer ses constantes et son empreinte`;
  const keys = new Set([...Object.keys(published.constants), ...Object.keys(constants)]);
  const changed = [...keys].filter((key) => published.constants[key] !== constants[key]);
  if (changed.length > 0) {
    return `constantes changées sans nouvelle version (${changed.map((key) => `${key}: ${published.constants[key]} → ${constants[key]}`).join(", ")}) : incrémenter MODEL_REGISTRY.gradient_boosted_trees.version`;
  }
  if (modelSha256 !== null && modelSha256 !== published.referenceModelSha256) {
    return `modèle de référence changé sans nouvelle version (${modelSha256}) : incrémenter MODEL_REGISTRY.gradient_boosted_trees.version`;
  }
  return null;
}

test("les constantes de gbdt.ts correspondent à la version déclarée du profil", () => {
  const version = MODEL_REGISTRY.gradient_boosted_trees.version;
  assert.equal(profileMismatch(version, exportedNumericConstants(gbdt), null), null);
});

test("le modèle livré sur le fichier de référence correspond à la version déclarée du profil", () => {
  const csv = readFileSync(resolve(process.cwd(), "public/examples/classification/credit-risk-train.csv"));
  const sha = createHash("sha256").update(gateModel(trainGradientBoostedTrees(csv)).buffer).digest("hex");
  assert.equal(profileMismatch(MODEL_REGISTRY.gradient_boosted_trees.version, exportedNumericConstants(gbdt), sha), null);
});

test("le contrôle attrape une constante modifiée, ajoutée ou retirée, et un changement d'algorithme", () => {
  const current = PUBLISHED_PROFILES["1.0.0"].constants;
  const sha = PUBLISHED_PROFILES["1.0.0"].referenceModelSha256;
  assert.match(profileMismatch("1.0.0", { ...current, GBDT_TREES: 151 }, sha)!, /GBDT_TREES: 150 → 151/);
  assert.match(profileMismatch("1.0.0", { ...current, GBDT_LEARNING_RATE: 0.05 }, sha)!, /GBDT_LEARNING_RATE/);
  assert.match(profileMismatch("1.0.0", { ...current, GBDT_SUBSAMPLE: 0.8 }, sha)!, /GBDT_SUBSAMPLE/);
  const { GBDT_L2: _removed, ...withoutL2 } = current;
  assert.match(profileMismatch("1.0.0", withoutL2, sha)!, /GBDT_L2: 1 → undefined/);
  assert.match(profileMismatch("1.0.0", current, "0".repeat(64))!, /modèle de référence changé/);
  assert.match(profileMismatch("1.0.1", current, sha)!, /absente/);
  assert.equal(profileMismatch("1.0.0", current, sha), null);
});
