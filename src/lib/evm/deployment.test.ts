import assert from "node:assert/strict";
import { afterEach, before, mock, test } from "node:test";
import { selectionForModelId, trainingProfileHash } from "@/lib/models/registry";

const ESCROW = `0x${"11".repeat(20)}`;
const DATASETS = `0x${"22".repeat(20)}`;
const BASE_PROFILES = [trainingProfileHash(selectionForModelId("linear_regression")), trainingProfileHash(selectionForModelId("logistic_regression"))];
const TREES_PROFILE = trainingProfileHash(selectionForModelId("gradient_boosted_trees"));
let client: ReturnType<typeof import("./client").getPublicClient>;
let deployment: typeof import("./deployment");

before(async () => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW;
  process.env.SIRIUS_DATASET_ADDRESS = DATASETS;
  client = (await import("./client")).getPublicClient();
  deployment = await import("./deployment");
});

afterEach(() => mock.restoreAll());

function stubDeployment(escrowVersion: string, registryVersion = "sirius-dataset-v4", linkedEscrow = ESCROW, profiles = BASE_PROFILES) {
  return mock.method(client, "readContract", async ({ address, functionName, args }: { address: string; functionName: string; args?: unknown[] }) => {
    if (functionName === "VERSION") return address === ESCROW ? escrowVersion : registryVersion;
    if (functionName === "datasets") return DATASETS;
    if (functionName === "escrow") return linkedEscrow;
    if (functionName === "isSupportedTrainingProfile") return profiles.includes(args?.[0] as `0x${string}`);
    throw new Error("Lecture inattendue");
  });
}

test("le reaper démarre sur v5 sans autoriser les nouveaux prêts v6", async () => {
  stubDeployment("sirius-escrow-usdc-v5");
  await deployment.requireReaperEvmDeployment();
  await assert.rejects(deployment.requireCurrentEvmDeployment(), /version de facturation/);
});

test("le reaper refuse les versions, liaisons et lectures RPC incompatibles", async () => {
  for (const [escrow, registry, linked] of [
    ["sirius-escrow-usdc-v4", "sirius-dataset-v4", ESCROW],
    ["sirius-escrow-usdc-v5", "sirius-dataset-v3", ESCROW],
    ["sirius-escrow-usdc-v6", "sirius-dataset-v4", DATASETS],
  ]) {
    const stub = stubDeployment(escrow, registry, linked);
    await assert.rejects(deployment.requireReaperEvmDeployment(), /Contrats du reaper incompatibles/);
    stub.mock.restore();
  }
  mock.method(client, "readContract", async () => { throw new Error("https://rpc.invalid/SECRET_SYNTHETIQUE"); });
  await assert.rejects(deployment.requireReaperEvmDeployment(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Contrats EVM Sirius indisponibles/);
    assert.ok(!error.message.includes("SECRET_SYNTHETIQUE"));
    return true;
  });
});

test("le reaper et les nouveaux prêts acceptent le déploiement v6 lié", async () => {
  stubDeployment("sirius-escrow-usdc-v6");
  await deployment.requireReaperEvmDeployment();
  await deployment.requireCurrentEvmDeployment();
});

test("activer v7 invalide le cache v6 et exige le contrat v7 lié", async () => {
  const previous = process.env.SIRIUS_BILLING_VERSION;
  try {
    process.env.SIRIUS_BILLING_VERSION = "6";
    const old = stubDeployment("sirius-escrow-usdc-v6");
    await deployment.requireCurrentEvmDeployment();
    process.env.SIRIUS_BILLING_VERSION = "7";
    await assert.rejects(deployment.requireCurrentEvmDeployment(), /version de facturation/);
    old.mock.restore();
    stubDeployment("sirius-escrow-usdc-v7");
    await deployment.requireCurrentEvmDeployment();
    await deployment.requireReaperEvmDeployment();
  } finally {
    if (previous === undefined) delete process.env.SIRIUS_BILLING_VERSION;
    else process.env.SIRIUS_BILLING_VERSION = previous;
  }
});

test("registre v4, v5 ou v6 : chaque profil proposé doit être accepté au mint, arbres compris une fois activés", async () => {
  const previous = process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
  try {
    delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
    for (const registry of ["sirius-dataset-v4", "sirius-dataset-v5", "sirius-dataset-v6"]) {
      const stub = stubDeployment("sirius-escrow-usdc-v6", registry);
      await deployment.requireCurrentEvmDeployment();
      stub.mock.restore();
    }
    process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = "gradient_boosted_trees";
    for (const registry of ["sirius-dataset-v4", "sirius-dataset-v5", "sirius-dataset-v6"]) {
      const stub = stubDeployment("sirius-escrow-usdc-v6", registry);
      await assert.rejects(deployment.requireCurrentEvmDeployment(), /profil d’entraînement proposé n’est pas accepté/);
      // Le reaper ne publie rien : il n'exige pas les profils proposés.
      await deployment.requireReaperEvmDeployment();
      stub.mock.restore();
    }
    stubDeployment("sirius-escrow-usdc-v6", "sirius-dataset-v5", ESCROW, [...BASE_PROFILES, TREES_PROFILE]);
    await deployment.requireCurrentEvmDeployment();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS;
    else process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = previous;
  }
});
