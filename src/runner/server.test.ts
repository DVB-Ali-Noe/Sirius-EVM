import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { issueRunnerCapability } from "@/lib/runner/capability";
import type { RunnerRaTlsEvidence } from "@/lib/tee/types";
import { handleRunnerRequest } from "./server";

interface TestResponse {
  body: unknown;
  status: number;
}

before(() => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.RUNNER_TRANSPORT_SECRET = Buffer.alloc(32, 12).toString("base64");
  process.env.SIRIUS_APP_ORIGIN = "http://localhost:3000";
});

async function request(
  method: string,
  url: string,
  capability?: string,
  body = "{}",
  includeLength = true,
  raTlsEvidence?: RunnerRaTlsEvidence,
): Promise<TestResponse> {
  const req = Readable.from(method === "POST" ? [body] : []) as IncomingMessage;
  Object.assign(req, {
    headers: {
      ...(capability ? { "x-sirius-runner-capability": capability } : {}),
      ...(method === "POST" && includeLength ? { "content-length": String(Buffer.byteLength(body)) } : {}),
    },
    method,
    url,
  });

  let status = 0;
  let responseBody = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk: string) {
      responseBody = chunk;
      return this;
    },
  } as unknown as ServerResponse;

  await handleRunnerRequest(req, res, raTlsEvidence);
  return { status, body: JSON.parse(responseBody) as unknown };
}

test("le contrat HTTP du runner impose healthcheck et capability", async () => {
  const health = await request("GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const unavailableRaTls = await request("GET", "/ra-tls");
  assert.equal(unavailableRaTls.status, 404);
  const evidence = {
    certificateSha256: "12".repeat(32),
    composeHash: "34".repeat(32),
    eventLog: "[]",
    ingressKeySha256: "78".repeat(32),
    masterKeyChainSha256: "9a".repeat(32),
    quote: "56",
  };
  const raTls = await request("GET", "/ra-tls", undefined, "{}", true, evidence);
  assert.equal(raTls.status, 200);
  assert.deepEqual(raTls.body, evidence);

  const unauthorized = await request("POST", "/dataset-ingress-key");
  assert.equal(unauthorized.status, 401);

  const capability = issueRunnerCapability("dataset-ingress-key", {});
  const authorized = await request("POST", "/dataset-ingress-key", capability);
  assert.equal(authorized.status, 200);
  const ingressKey = authorized.body as { origin: string; publicKey: string };
  assert.equal(Buffer.from(ingressKey.publicKey, "base64url").length, 65);
  assert.equal(ingressKey.origin, "http://localhost:3000");

  const replayed = await request("POST", "/dataset-ingress-key", capability);
  assert.equal(replayed.status, 409);

  const missingLength = await request(
    "POST",
    "/dataset-ingress-key",
    issueRunnerCapability("dataset-ingress-key", {}),
    "{}",
    false,
  );
  assert.equal(missingLength.status, 411);

  const oversized = await request(
    "POST",
    "/dataset-ingress-key",
    issueRunnerCapability("dataset-ingress-key", {}),
    "x".repeat(256 * 1024 + 1),
  );
  assert.equal(oversized.status, 413);

  const hashlockBody = JSON.stringify({
    loanId: "loan-2",
    borrower: "rBorrower",
  });
  const wrongScope = await request(
    "POST",
    "/escrow-hashlock",
    issueRunnerCapability("escrow-hashlock", {
      loanId: "loan-1",
      borrower: "rBorrower",
    }),
    hashlockBody,
  );
  assert.equal(wrongScope.status, 401);

  const validationBody = JSON.stringify({
    datasetId: "dataset-1",
    cid: "bafy-dataset",
    wrappedKey: "wrapped-key",
    merkleRoot: "a".repeat(64),
    priceUsdcAtomic: "1000000000000000000",
    challengeDays: 7,
    modelId: "other",
    modelVersion: "1.0.0",
    datasetReceipt: "not-read-before-model-validation",
  });
  const validation = await request(
    "POST",
    "/validate-training",
    issueRunnerCapability("validate-training", { datasetId: "dataset-1" }),
    validationBody,
  );
  assert.equal(validation.status, 400);
  assert.deepEqual(validation.body, { error: "Modèle ou version non autorisé" });

  const validationWrongScope = await request(
    "POST",
    "/validate-training",
    issueRunnerCapability("validate-training", { datasetId: "dataset-2" }),
    validationBody,
  );
  assert.equal(validationWrongScope.status, 401);
});
