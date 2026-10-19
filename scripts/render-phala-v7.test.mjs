import assert from "node:assert/strict";
import { test } from "node:test";
import { OPT_IN_MODELS, renderPhalaV7 } from "./render-phala-v7.mjs";
import { MODEL_REGISTRY } from "../src/lib/models/registry";

const image = `ghcr.io/dvb-ali-noe/sirius-runner@sha256:${"12".repeat(32)}`;

test("la démonstration a ses volumes propres et ne force pas l’ancienne origine staging", () => {
  for (const mode of ["demo-init", "demo-active"]) {
    const model = renderPhalaV7(mode, image);
    assert.equal(model.volumes.runner_budget.name, "sirius_phala_demo_budget");
    assert.equal(model.volumes.runner_replay.name, "sirius_phala_demo_replay");
    assert.equal(model.services.runner.environment.SIRIUS_APP_ORIGIN, "${SIRIUS_APP_ORIGIN}");
    assert.equal(model.services.runner.environment.PINATA_JWT, "${PINATA_JWT}");
    assert.equal(model.services.runner.environment.SIRIUS_PHALA_DEMO, "true");
    assert.equal(model.services.runner.environment.RUNNER_BOOTSTRAP_ONLY, mode === "demo-init" ? "true" : "false");
    if (mode === "demo-init") assert.equal(model.services["initialize-v7"].network_mode, "none");
  }
});

test("les Compose staging figent l'image sans interpoler les secrets ni renommer les volumes", () => {
  for (const mode of ["bootstrap", "init", "active", "wallets"]) {
    const model = renderPhalaV7(mode, image, "https://sirius-evm-staging.vercel.app");
    assert.equal(model.name, undefined);
    assert.equal(model.volumes.runner_replay.name, undefined);
    assert.equal(model.volumes.runner_budget.name, undefined);
    assert.ok(Object.values(model.services).every((service) => service.image === image));
    const runner = model.services.runner;
    assert.equal(runner.environment.RUNNER_BOOTSTRAP_ONLY, mode === "active" ? "false" : "true");
    assert.equal(runner.environment.RUNNER_TRANSPORT_SECRET, "${RUNNER_TRANSPORT_SECRET}");
    assert.equal(runner.environment.PINATA_JWT, "${PINATA_JWT}");
    assert.equal(runner.environment.SIRIUS_APP_ORIGIN, "https://sirius-evm-staging.vercel.app");
    assert.ok(runner.volumes.some((volume) => volume.source === "runner_replay"));
    assert.ok(runner.volumes.some((volume) => volume.source === "runner_budget"));
    if (mode === "init") {
      const init = model.services["initialize-v7"];
      assert.equal(init.environment.EVM_NETWORK, "${EVM_NETWORK:?Réseau EVM requis}");
      assert.equal(init.restart, "no");
      assert.equal(init.network_mode, "none");
      assert.ok(init.volumes.every((volume) => volume.type === "volume"));
      assert.ok(!Object.hasOwn(init.environment, "RUNNER_TRANSPORT_SECRET"));
    } else if (mode === "wallets") {
      const maintenance = model.services["add-trial-wallets"];
      assert.equal(maintenance.restart, "no");
      assert.equal(maintenance.network_mode, "none");
      assert.ok(maintenance.volumes.every((volume) => volume.source === "runner_budget"));
      assert.ok(!Object.hasOwn(maintenance.environment, "RUNNER_TRANSPORT_SECRET"));
    } else assert.deepEqual(Object.keys(model.services), ["runner"]);
    if (mode === "active") {
      assert.equal(runner.environment.SIRIUS_BILLING_VERSION, "7");
      assert.equal(runner.environment.SIRIUS_EVM_FINALITY, "finalized");
      // Finalité rapide : constantes attestées, jamais interpolées depuis l'environnement chiffré.
      assert.equal(runner.environment.SIRIUS_FAST_FINALITY, "true");
      assert.equal(runner.environment.SIRIUS_FAST_FINALITY_MAX_USDC, "25");
      assert.equal(runner.environment.SIRIUS_FAST_FINALITY_CONFIRMATIONS, "30");
      assert.equal(runner.environment.SIRIUS_FAST_FINALITY_TOTAL_USDC, "100", "plafond d'exposition rapide propre à l'enclave");
    } else {
      assert.ok(!Object.hasOwn(runner.environment, "SIRIUS_FAST_FINALITY"), `${mode} : pas de finalité rapide hors runner actif`);
    }
  }
});

test("le rendu refuse un tag mutable, un autre registre et un mode inconnu", () => {
  for (const value of ["ghcr.io/dvb-ali-noe/sirius-runner:staging", image.replace("sirius-runner", "unexpected-runner")]) {
    assert.throws(() => renderPhalaV7("active", value, "https://sirius-data.tech"));
  }
  assert.throws(() => renderPhalaV7("restore", image, "https://sirius-data.tech"));
});

test("la production reçoit son origine explicitement, jamais celle du staging par défaut", () => {
  const model = renderPhalaV7("active", image, "https://sirius-data.tech");
  assert.equal(model.services.runner.environment.SIRIUS_APP_ORIGIN, "https://sirius-data.tech");
  assert.throws(() => renderPhalaV7("active", image), /Origine/);
  for (const origin of ["http://sirius-data.tech", "https://sirius-data.tech/", "https://sirius-data.tech/app", "https://sirius-data.tech:8443", "sirius-data.tech"]) {
    assert.throws(() => renderPhalaV7("active", image, origin), /Origine/, origin);
  }
  assert.throws(() => renderPhalaV7("demo-active", image, "https://sirius-data.tech"), /Origine/, "la démonstration garde son origine chiffrée");
});

test("la mise à jour du tarif est une maintenance ponctuelle, hors réseau, sur le volume budget seul", () => {
  for (const [mode, origin] of [["billing", "https://sirius-evm-staging.vercel.app"], ["demo-billing", undefined]]) {
    const model = renderPhalaV7(mode, image, origin);
    const update = model.services["update-billing-policy"];
    assert.equal(update.restart, "no");
    assert.equal(update.network_mode, "none");
    assert.equal(update.environment.RUNNER_VOLUME_ACTION, "update-billing-policy");
    assert.equal(update.environment.RUNNER_UPDATED_BILLING_POLICY, "${RUNNER_UPDATED_BILLING_POLICY:?Tarif approuvé requis}");
    assert.ok(update.volumes.every((volume) => volume.source === "runner_budget"));
    assert.ok(!Object.hasOwn(update.environment, "RUNNER_TRANSPORT_SECRET"));
    assert.equal(model.services.runner.environment.RUNNER_BOOTSTRAP_ONLY, "true", "le runner ne sert rien pendant la mise à jour");
    if (mode === "demo-billing") assert.equal(model.volumes.runner_budget.name, "sirius_phala_demo_budget");
  }
});

test("la prolongation du budget vise le seul volume de démonstration et précède le tarif", () => {
  for (const mode of ["demo-budget", "demo-renewal"]) {
    const model = renderPhalaV7(mode, image);
    const renew = model.services["renew-budget-policy"];
    assert.equal(renew.restart, "no");
    assert.equal(renew.network_mode, "none");
    assert.equal(renew.environment.RUNNER_BUDGET_RENEWAL, "${RUNNER_BUDGET_RENEWAL:?Prolongation approuvée requise}");
    assert.ok(renew.volumes.every((volume) => volume.source === "runner_budget"));
    assert.equal(model.volumes.runner_budget.name, "sirius_phala_demo_budget");
    assert.equal(model.services.runner.environment.RUNNER_BOOTSTRAP_ONLY, "true");
  }
  assert.ok(!Object.hasOwn(renderPhalaV7("demo-budget", image).services, "update-billing-policy"));
  const renewal = renderPhalaV7("demo-renewal", image);
  assert.deepEqual(renewal.services["update-billing-policy"].depends_on,
    { "renew-budget-policy": { condition: "service_completed_successfully", required: true } });
});

test("l'interrupteur des profils facultatifs est écrit en clair dans le seul Compose actif", () => {
  assert.deepEqual(OPT_IN_MODELS, Object.values(MODEL_REGISTRY).filter((model) => model.optIn).map((model) => model.id));
  const demo = renderPhalaV7("demo-active", image, undefined, "gradient_boosted_trees");
  assert.equal(demo.services.runner.environment.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS, "gradient_boosted_trees");
  const staging = renderPhalaV7("active", image, "https://sirius-evm-staging.vercel.app", " gradient_boosted_trees ");
  assert.equal(staging.services.runner.environment.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS, "gradient_boosted_trees");
  assert.ok(!Object.hasOwn(renderPhalaV7("demo-active", image).services.runner.environment, "NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS"), "coupé par défaut");
  for (const value of ["linear_regression", "unknown", "gradient_boosted_trees,gradient_boosted_trees", "${NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS}"]) {
    assert.throws(() => renderPhalaV7("demo-active", image, undefined, value), /facultatif/, value);
  }
  for (const mode of ["demo-billing", "demo-init"]) assert.throws(() => renderPhalaV7(mode, image, undefined, "gradient_boosted_trees"), /Compose actif/);
});
