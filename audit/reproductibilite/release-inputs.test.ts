/**
 * Audit reproductibilité, partie A : ce que la « release prouvée » couvre, et ce qu'elle laisse
 * dehors. Lecture seule des fichiers publiés sous src/lib/phala-demo/composes/ et du Dockerfile.
 *
 * Deux sortes de tests :
 *  - constats (passent aujourd'hui) : figent le comportement actuel décrit dans le rapport ;
 *  - attendus (`todo`) : la propriété souhaitée ; ils échouent sans casser la suite tant que la
 *    correction proposée n'est pas faite, et passeront d'eux-mêmes ensuite.
 *
 * Lancer : NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/reproductibilite/release-inputs.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DECLARED_RELEASES, PUBLISHED_COMPOSES_DIR, resolveCodeRelease } from "../../src/lib/phala-demo/attestation";
import { isModelOffered } from "../../src/lib/models/registry";

const ROOT = resolve(__dirname, "..", "..");

interface AppCompose {
  allowed_envs: string[];
  docker_compose_file: string;
  pre_launch_script: string;
  secure_time?: boolean;
}

const published = readdirSync(PUBLISHED_COMPOSES_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => {
    const bytes = readFileSync(join(PUBLISHED_COMPOSES_DIR, name));
    const app = JSON.parse(bytes.toString("utf8")) as AppCompose;
    const compose = JSON.parse(app.docker_compose_file) as { services: Record<string, { image: string; environment: Record<string, string> }> };
    return { hash: name.slice(0, -5), bytes, app, runner: compose.services.runner };
  });

test("constat : chaque compose publié est « prouvé » et relié à une entrée de DECLARED_RELEASES", async () => {
  assert.ok(published.length >= 3);
  for (const item of published) {
    assert.equal(createHash("sha256").update(item.bytes).digest("hex"), item.hash);
    const release = await resolveCodeRelease(item.hash);
    assert.equal(release.status, "proven");
    assert.equal(release.status === "proven" && release.image, DECLARED_RELEASES[item.hash]?.image);
    assert.equal(release.status === "proven" && release.commit, DECLARED_RELEASES[item.hash]?.commit);
  }
});

test("REP-03 constat : adresses de contrats, RPC et origine viennent de l'environnement chiffré, hors hash attesté", () => {
  const unattested = ["EVM_RPC_URL", "SIRIUS_ESCROW_ADDRESS", "SIRIUS_DATASET_ADDRESS", "SIRIUS_KYB_ADDRESS",
    "SIRIUS_USDC_ADDRESS", "SIRIUS_APP_ORIGIN", "SIRIUS_LOCK_AUTHORIZER", "SIRIUS_EVM_CONFIRMATIONS", "PINATA_GATEWAY"];
  for (const item of published) {
    for (const name of unattested) {
      assert.match(item.runner.environment[name] ?? "", /^\$\{[A-Z_]+(:[-?][^}]*)?\}$/, `${item.hash.slice(0, 8)} ${name} devrait être une interpolation`);
      assert.ok(item.app.allowed_envs.includes(name), `${name} doit figurer dans allowed_envs`);
    }
  }
});

test("REP-04 constat : le script de pré-lancement attesté installe des clés SSH root lues dans /dstack/user_config", () => {
  for (const item of published) {
    const script = item.app.pre_launch_script;
    assert.match(script, /jq -r '\.ssh_authorized_keys' \/dstack\/user_config >> \/home\/root\/\.ssh\/authorized_keys/);
    // Les variables d'accès root ne peuvent pas venir de l'environnement chiffré : bon point.
    for (const name of ["DSTACK_ROOT_PASSWORD", "DSTACK_ROOT_PUBLIC_KEY", "DSTACK_AUTHORIZED_KEYS"]) {
      assert.ok(!item.app.allowed_envs.includes(name), `${name} ne doit pas être accepté`);
    }
    assert.equal(item.app.secure_time, false);
  }
});

test("REP-07 constat : le profil arbres dépend du compose actif côté runner, indépendamment du build du site", () => {
  const runnerOffers = Object.fromEntries(published.map((item) => [
    item.hash.slice(0, 8), isModelOffered("gradient_boosted_trees", item.runner.environment.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS),
  ]));
  assert.deepEqual(runnerOffers, { "0c3f6f87": true, "2fdc0919": true, "61581af7": false });
  // Le site, lui, lit la valeur figée par `next build` : rien ne compare les deux.
  for (const site of [undefined, "gradient_boosted_trees"]) {
    for (const runner of [undefined, "gradient_boosted_trees"]) {
      const divergent = isModelOffered("gradient_boosted_trees", site) !== isModelOffered("gradient_boosted_trees", runner);
      assert.equal(divergent, site !== runner);
    }
  }
});

test("REP-07 constat : le runner revérifie le profil APRÈS paiement (run-loan-job), pas seulement au verrouillage", () => {
  const handler = readFileSync(resolve(ROOT, "src/runner/handler.ts"), "utf8");
  const runLoanJob = handler.slice(handler.indexOf('case "run-loan-job": {'), handler.indexOf('case "recover-loan-job": {'));
  assert.match(runLoanJob, /datasetRef\(body\)/);
  assert.match(handler, /function datasetRef[\s\S]*?\.\.\.trainingModel\(body\)/);
  assert.match(handler, /function trainingModel[\s\S]*?isModelOffered\(selection\.modelId\)/);
});

test("REP-02 constat : l'image runner embarque tout src/, donc toute modification du site change son digest", () => {
  const dockerfile = readFileSync(resolve(ROOT, "Dockerfile.runner"), "utf8");
  assert.match(dockerfile, /^COPY --chown=node:node src \.\/src$/m);
  // Exemple : DECLARED_RELEASES (code du site) est dans l'image qu'il décrit.
  assert.ok(PUBLISHED_COMPOSES_DIR.replaceAll("\\", "/").includes("src/lib/phala-demo/composes"));
});

test("REP-01 attendu : chaque FROM de Dockerfile.runner est épinglé par digest", { todo: "base par tag flottant" }, () => {
  const dockerfile = readFileSync(resolve(ROOT, "Dockerfile.runner"), "utf8");
  const froms = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
  assert.ok(froms.length > 0);
  for (const line of froms) assert.match(line, /@sha256:[0-9a-f]{64}/, line);
});

test("REP-06 attendu : chaque commit déclaré est un SHA complet (40 caractères)", { todo: "SHA abrégés à 7 caractères" }, () => {
  for (const { commit } of Object.values(DECLARED_RELEASES)) assert.match(commit, /^[0-9a-f]{40}$/);
});
