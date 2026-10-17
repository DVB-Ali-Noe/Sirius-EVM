import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";
import { runSelfTraining, sealDataset } from "@/lib/tee/core";

test("le self-train de 30 000 lignes livre un modèle et respecte le délai du worker", { timeout: 35_000 }, async () => {
  const originalFetch = globalThis.fetch;
  const keys = ["TEE_MODE", "EVM_NETWORK", "SIRIUS_MASTER_KEY", "PINATA_JWT", "PINATA_GATEWAY", "RUNNER_BUDGET_FILE"] as const;
  const previous = keys.map((key) => process.env[key]);
  const blobs = new Map<string, Buffer>();
  let uploads = 0;
  Object.assign(process.env, {
    TEE_MODE: "stub", EVM_NETWORK: "testnet",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"),
    PINATA_JWT: "synthetic-only", PINATA_GATEWAY: "https://ipfs.test.invalid",
  });
  delete process.env.RUNNER_BUDGET_FILE;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://uploads.pinata.cloud/v3/files") {
      const file = (init?.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const cid = `bafy-synthetic-${++uploads}`;
      blobs.set(cid, bytes);
      return Response.json({ data: { cid, size: bytes.length } });
    }
    if (url.startsWith("https://ipfs.test.invalid/ipfs/")) {
      const blob = blobs.get(url.split("/").at(-1)!);
      assert.ok(blob);
      return new Response(new Uint8Array(blob));
    }
    throw new Error(`Requête extérieure inattendue : ${url}`);
  };
  try {
    const header = [...Array.from({ length: 23 }, (_, index) => `f${index}`), "y"].join(",");
    const rows = Array.from({ length: 30_000 }, (_, index) => [
      index % 2,
      ...Array.from({ length: 22 }, (_, feature) => String((index * 37 + feature * 71) % 1000).padStart(3, "0")),
      index % 2,
    ].join(","));
    const csv = Buffer.from([header, ...rows].join("\n"));
    assert.ok(csv.length < 3 * 1024 * 1024);
    const sealed = await sealDataset("capacity-test", csv);
    const input = {
      datasetId: "capacity-test", ...sealed, priceUsdcAtomic: "1", challengeDays: 1,
      modelId: "logistic_regression" as const, modelVersion: "1.0.0" as const,
      owner: `0x${"1".repeat(40)}`, jobId: "capacity-success",
    };
    const result = await runSelfTraining(input, 15_000);
    assert.equal(result.metrics.n, 30_000);
    assert.equal(uploads, 2, "dataset et modèle chiffré sont stockés");

    await assert.rejects(
      runSelfTraining({ ...input, jobId: "capacity-timeout" }, 1),
      (error) => error instanceof AppError && error.status === 503,
    );
    assert.equal(uploads, 2, "un calcul interrompu ne doit pas publier de modèle");
  } finally {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});
