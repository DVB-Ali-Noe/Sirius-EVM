import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPhalaV7 } from "./render-phala-v7.mjs";

const image = `ghcr.io/dvb-ali-noe/sirius-runner@sha256:${"12".repeat(32)}`;

test("les Compose staging figent l'image sans interpoler les secrets ni renommer les volumes", () => {
  for (const mode of ["bootstrap", "init", "active", "wallets"]) {
    const model = renderPhalaV7(mode, image);
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
    }
  }
});

test("le rendu refuse un tag mutable, un autre registre et un mode inconnu", () => {
  for (const value of ["ghcr.io/dvb-ali-noe/sirius-runner:staging", image.replace("sirius-runner", "unexpected-runner")]) {
    assert.throws(() => renderPhalaV7("active", value));
  }
  assert.throws(() => renderPhalaV7("restore", image));
});
