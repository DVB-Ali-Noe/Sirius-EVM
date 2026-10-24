/**
 * Audit EXA-06 : échoue si une constante de `gbdt.ts` ou le comportement de l'entraînement change
 * sans que la version du profil `gradient_boosted_trees` change dans `registry.ts`. La version entre
 * dans `trainingProfileHash`, publié on-chain : la changer en silence ferait attester sous le même
 * identifiant un autre algorithme que celui que l'acheteur a choisi.
 *
 * Chaque version publiée est figée ici avec (1) toutes les constantes numériques exportées par
 * `gbdt.ts`, relevées automatiquement (une constante ajoutée ou retirée compte aussi), et (2)
 * l'empreinte SHA-256 du modèle livré sur deux fichiers de référence du dépôt, qui attrapent un
 * changement d'algorithme dans `train-gbdt.ts` à constantes égales. Le second a un nombre de lignes
 * d'entraînement « non rond » (13 000 lignes, 10 400 entraînées, 10 400 / 64 = 162,5) : sur le
 * premier (8 320 / 64 = 130), un `Math.floor` remplacé par `Math.round` dans les quantiles ne
 * change rien.
 *
 * Changer le profil impose donc d'incrémenter `MODEL_REGISTRY.gradient_boosted_trees.version` et
 * d'ajouter une entrée ci-dessous ; une version déjà publiée ne peut plus changer de contenu.
 *
 * Vérifié par mutation (`audit/exactitude/tests/mutate-gbdt.cjs` de la branche d'audit) :
 * `GBDT_TREES = 150 → 149`, une coupe presque aussi bonne retenue à la place de la meilleure, et
 * `Math.floor → Math.round` dans les quantiles font tous échouer ce fichier.
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

const REFERENCE_FILES = ["credit-risk-train.csv", "credit-risk.csv"] as const;
type ReferenceFile = (typeof REFERENCE_FILES)[number];

/** Versions publiées : ne jamais modifier une entrée existante, en ajouter une. */
const PUBLISHED_PROFILES: Record<string, { constants: Constants; referenceModelSha256: Record<ReferenceFile, string> }> = {
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
    // gateModel(trainGradientBoostedTrees(public/examples/classification/<fichier>)).buffer
    referenceModelSha256: {
      "credit-risk-train.csv": "94c88d033420be3bf80afca4d4428d51f08b82be64d4eacb04d9fe5f6a81c865",
      "credit-risk.csv": "f466532d8d7196b3e174dbf4f08274eb17a6f506f62d340958ace3d7fa2a61d2",
    },
  },
  // 1.1.0 (24 octobre 2026, E2 minimale) : plafond d'influence k = 1, seuils strictement entre deux
  // valeurs, métriques arrondies, `aucGap` à la place de `trainAuc`, `n` à 2 chiffres.
  "1.1.0": {
    constants: {
      BASE_SCORE_SIG_FIGS: 3,
      GBDT_AUC_GAP_DECIMALS: 2,
      GBDT_BINS: 64,
      GBDT_HOLDOUT_EVERY: 5,
      GBDT_INFLUENCE_CAP: 1,
      GBDT_L2: 1,
      GBDT_LEARNING_RATE: 0.1,
      GBDT_MAX_DEPTH: 2,
      GBDT_MAX_OPERATIONS: 300_000_000,
      GBDT_METRIC_DECIMALS: 3,
      GBDT_MIN_LEAF_ROWS: 1_000,
      GBDT_MIN_ROWS: 10_000,
      GBDT_ROW_COUNT_SIG_FIGS: 2,
      GBDT_TREES: 150,
      LEAF_SIG_FIGS: 4,
      THRESHOLD_MAX_SIG_FIGS: 6,
      THRESHOLD_SIG_FIGS: 3,
    },
    referenceModelSha256: {
      "credit-risk-train.csv": "e31cc07c939644eafaaa8ba0beaab9964d917efebcf44d2f9afca34d2a2a102d",
      "credit-risk.csv": "f6538783b1890320cab25593c8dc9f9b988ae7fce3e1fdf6bae4d7850b4a0baf",
    },
  },
};

function exportedNumericConstants(module: Record<string, unknown>): Constants {
  return Object.fromEntries(
    Object.entries(module).filter(([, value]) => typeof value === "number").sort(([a], [b]) => a.localeCompare(b)),
  ) as Constants;
}

/** `null` si le profil courant correspond à la version déclarée, sinon le motif. */
function profileMismatch(version: string, constants: Constants, models: Partial<Record<ReferenceFile, string>> = {}): string | null {
  const published = PUBLISHED_PROFILES[version];
  if (!published) return `version ${version} absente de PUBLISHED_PROFILES : figer ses constantes et ses empreintes`;
  const keys = new Set([...Object.keys(published.constants), ...Object.keys(constants)]);
  const changed = [...keys].filter((key) => published.constants[key] !== constants[key]);
  if (changed.length > 0) {
    return `constantes changées sans nouvelle version (${changed.map((key) => `${key}: ${published.constants[key]} → ${constants[key]}`).join(", ")}) : incrémenter MODEL_REGISTRY.gradient_boosted_trees.version`;
  }
  for (const [file, sha] of Object.entries(models) as [ReferenceFile, string][]) {
    if (sha !== published.referenceModelSha256[file]) {
      return `modèle de référence ${file} changé sans nouvelle version (${sha}) : incrémenter MODEL_REGISTRY.gradient_boosted_trees.version`;
    }
  }
  return null;
}

function referenceModelSha256(file: ReferenceFile): string {
  const csv = readFileSync(resolve(process.cwd(), "public/examples/classification", file));
  return createHash("sha256").update(gateModel(trainGradientBoostedTrees(csv)).buffer).digest("hex");
}

test("les constantes de gbdt.ts correspondent à la version déclarée du profil", () => {
  assert.equal(profileMismatch(MODEL_REGISTRY.gradient_boosted_trees.version, exportedNumericConstants(gbdt)), null);
});

for (const file of REFERENCE_FILES) {
  test(`le modèle livré sur ${file} correspond à la version déclarée du profil`, () => {
    const version = MODEL_REGISTRY.gradient_boosted_trees.version;
    assert.equal(profileMismatch(version, exportedNumericConstants(gbdt), { [file]: referenceModelSha256(file) }), null);
  });
}

test("le contrôle attrape une constante modifiée, ajoutée ou retirée, et un changement d'algorithme", () => {
  const current = PUBLISHED_PROFILES["1.0.0"].constants;
  const models = PUBLISHED_PROFILES["1.0.0"].referenceModelSha256;
  assert.match(profileMismatch("1.0.0", { ...current, GBDT_TREES: 151 }, models)!, /GBDT_TREES: 150 → 151/);
  assert.match(profileMismatch("1.0.0", { ...current, GBDT_LEARNING_RATE: 0.05 }, models)!, /GBDT_LEARNING_RATE/);
  assert.match(profileMismatch("1.0.0", { ...current, GBDT_SUBSAMPLE: 0.8 }, models)!, /GBDT_SUBSAMPLE/);
  const withoutL2 = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "GBDT_L2"));
  assert.match(profileMismatch("1.0.0", withoutL2, models)!, /GBDT_L2: 1 → undefined/);
  assert.match(profileMismatch("1.0.0", current, { "credit-risk.csv": "0".repeat(64) })!, /credit-risk\.csv changé/);
  assert.match(profileMismatch("1.0.1", current, models)!, /absente/);
  assert.equal(profileMismatch("1.0.0", current, models), null);
});
