import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { borrowDataset, settleLoan, SETTLEMENT_PENDING_RETRY_MS, SETTLEMENT_QUEUED_RETRY_MS } from "./client";
import { isSettlementPending, SETTLEMENT_FINALITY_PENDING, SETTLEMENT_FINALITY_PENDING_FAST, SETTLEMENT_QUEUED } from "./settlement-status";
import { AppError } from "@/lib/app-error";
import { RUNNER_WALLET_BUSY } from "@/lib/runner/failure-policy";
import { settlementQueuedError } from "@/lib/sirius/settlement-queued";
import type { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { useWalletStore } from "@/stores/wallet";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult } from "viem";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { siriusdatasetregistryAbi } from "@/lib/evm/abi/siriusdatasetregistry";
import { erc20Abi } from "@/lib/evm/abi/erc20";
import { datasetIdHash } from "@/lib/evm/dataset-key";
import { loanIdHash } from "@/lib/evm/loan-key";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "loans", "client.ts"), "utf8");

test("le lock est réautorisé après confirmation de l'approbation USDC", async () => {
  const events: string[] = [];
  const stored = new Map<string, string>();
  const previousEscrow = process.env.SIRIUS_ESCROW_ADDRESS;
  const previousUsdc = process.env.SIRIUS_USDC_ADDRESS;
  const previousDataset = process.env.SIRIUS_DATASET_ADDRESS;
  process.env.SIRIUS_ESCROW_ADDRESS = `0x${"11".repeat(20)}`;
  process.env.SIRIUS_USDC_ADDRESS = `0x${"22".repeat(20)}`;
  process.env.SIRIUS_DATASET_ADDRESS = `0x${"33".repeat(20)}`;
  const provider = `0x${"44".repeat(20)}` as const;
  const profile = `0x${"55".repeat(32)}` as const;
  const hashlock = `0x${"66".repeat(32)}` as const;
  const onChainDatasetId = datasetIdHash("dataset-renew");
  const deadline = Math.floor(Date.now() / 1000) + 240;
  const lock = (signature: `0x${string}`) => ({ to: process.env.SIRIUS_ESCROW_ADDRESS!, data: encodeFunctionData({
    abi: siriusescrowAbi, functionName: "lock", args: [provider, BigInt(100), hashlock, 1,
      loanIdHash("loan-renew"), onChainDatasetId, profile, { deadline, signature }],
  }) });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    ethereum: { request: async ({ method, params }: { method: string; params?: { to?: string; data?: string }[] }) => {
      if (method === "eth_chainId") return "0xb626";
      if (method === "eth_call") {
        if (params?.[0]?.to === process.env.SIRIUS_DATASET_ADDRESS) {
          const call = decodeFunctionData({ abi: siriusdatasetregistryAbi, data: params![0].data as `0x${string}` });
          return call.functionName === "datasetIdOf"
            ? encodeFunctionResult({ abi: siriusdatasetregistryAbi, functionName: "datasetIdOf", result: onChainDatasetId })
            : encodeFunctionResult({ abi: siriusdatasetregistryAbi, functionName: "getDataset", result: {
              provider, mintedAt: 1, destroyedAt: 0, sizeBytes: BigInt(10), merkleRoot: hashlock,
              cidHash: hashlock, trainingProfile: profile,
            } });
        }
        return encodeAbiParameters([{ type: "string" }], ["sirius-escrow-usdc-v6"]);
      }
      if (method === "eth_getTransactionReceipt") { events.push("confirmed"); return { status: "0x1" }; }
      if (method === "eth_sendTransaction") { events.push(params?.[0].data ?? ""); return `0x${"11".repeat(32)}`; }
      throw new Error(method);
    } },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  } });
  useWalletStore.getState().setConnected("0x1111111111111111111111111111111111111111", "testnet", "external");
  useWalletStore.getState().setAuthenticated(true);
  mock.method(globalThis, "fetch", async (input: string) => {
    if (input === "/api/loans") return Response.json({ loanId: "loan-renew", approveTransaction: { data: "untrusted" }, lockTransaction: lock("0x11") });
    if (input.endsWith("/authorize")) {
      events.push("renewed");
      return Response.json({ lockTransaction: lock("0x22"), authorizationDeadline: deadline });
    }
    if (input.endsWith("/submit")) { events.push("submitted"); return Response.json({}); }
    throw new Error(input);
  });
  try {
    await borrowDataset({ datasetId: "dataset-renew", priceUsdcAtomic: "100" });
    assert.equal(decodeFunctionData({ abi: erc20Abi, data: events[0] as `0x${string}` }).functionName, "approve");
    assert.deepEqual(events.slice(1, 3), ["confirmed", "renewed"]);
    assert.equal(decodeFunctionData({ abi: siriusescrowAbi, data: events[3] as `0x${string}` }).functionName, "lock");
    assert.equal(events[4], "submitted");
    assert.equal(stored.size, 0);
  } finally {
    mock.restoreAll();
    useWalletStore.getState().setDisconnected();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousEscrow === undefined) delete process.env.SIRIUS_ESCROW_ADDRESS;
    else process.env.SIRIUS_ESCROW_ADDRESS = previousEscrow;
    if (previousUsdc === undefined) delete process.env.SIRIUS_USDC_ADDRESS;
    else process.env.SIRIUS_USDC_ADDRESS = previousUsdc;
    if (previousDataset === undefined) delete process.env.SIRIUS_DATASET_ADDRESS;
    else process.env.SIRIUS_DATASET_ADDRESS = previousDataset;
  }
});

test("un lock v6 opaque ou hors contrat ne déclenche aucune signature", async () => {
  const previousEscrow = process.env.SIRIUS_ESCROW_ADDRESS;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  process.env.SIRIUS_ESCROW_ADDRESS = `0x${"11".repeat(20)}`;
  let sent = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0xb626";
      if (method === "eth_call") return encodeAbiParameters([{ type: "string" }], ["sirius-escrow-usdc-v6"]);
      if (method === "eth_sendTransaction") { sent++; return `0x${"11".repeat(32)}`; }
      throw new Error(method);
    },
  } } });
  useWalletStore.getState().setConnected("0x1111111111111111111111111111111111111111", "testnet", "external");
  useWalletStore.getState().setAuthenticated(true);
  mock.method(globalThis, "fetch", async () => Response.json({ loanId: "loan", approveTransaction: {
    to: `0x${"99".repeat(20)}`, data: "0x1234",
  }, lockTransaction: { to: `0x${"99".repeat(20)}`, data: "0x1234" } }));
  try {
    await assert.rejects(borrowDataset({ datasetId: "dataset", priceUsdcAtomic: "100" }), /Transaction de lock invalide/);
    assert.equal(sent, 0);
  } finally {
    mock.restoreAll();
    useWalletStore.getState().setDisconnected();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousEscrow === undefined) delete process.env.SIRIUS_ESCROW_ADDRESS;
    else process.env.SIRIUS_ESCROW_ADDRESS = previousEscrow;
  }
});

test("le hash de lock est persisté et soumis immédiatement au serveur", () => {
  const borrow = SOURCE.slice(SOURCE.indexOf("export async function borrowDataset"), SOURCE.indexOf("export async function resumeLoanSubmission"));

  assert.ok(
    borrow.indexOf("window.sessionStorage.setItem") < borrow.indexOf("await submitLoanLock"),
    "un hash déjà signé doit rester récupérable si la confirmation tarde",
  );
  assert.doesNotMatch(borrow, /await waitForTransactionExternal/);
});

test("PAR-02 : un règlement refusé parce qu'un autre occupe le wallet runner est redemandé, avec une autorisation neuve à chaque essai", async () => {
  const previousFetch = globalThis.fetch;
  const waits: number[] = [];
  const bodies: string[] = [];
  const answers: { status: number; body: object }[] = [
    { status: 503, body: { error: SETTLEMENT_QUEUED } },
    { status: 503, body: { error: SETTLEMENT_QUEUED } },
    { status: 200, body: { loanId: "loan-queued" } },
  ];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    const answer = answers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  let issued = 0;
  const grant: typeof issueRunnerGrant = async () => ({ grant: `grant-${issued++}` }) as never;
  try {
    await settleLoan("loan-queued", "receipt", { grant, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, SETTLEMENT_QUEUED_RETRY_MS.slice(0, 2));
    assert.equal(new Set(bodies).size, 3, "chaque essai porte son propre grant");

    // Au-delà des essais prévus, le message lisible remonte ; toute autre erreur n'est jamais relancée.
    answers.push(...Array.from({ length: SETTLEMENT_QUEUED_RETRY_MS.length + 1 }, () => ({ status: 503, body: { error: SETTLEMENT_QUEUED } })));
    await assert.rejects(settleLoan("loan-queued", "receipt", { grant, wait: async () => {} }), { message: SETTLEMENT_QUEUED });
    assert.equal(answers.length, 0);
    answers.push({ status: 503, body: { error: "Runner confidentiel indisponible" } });
    await assert.rejects(settleLoan("loan-queued", "receipt", { grant, wait: async () => assert.fail("pas de relance") }),
      { message: "Runner confidentiel indisponible" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("règlement au palier rapide : la page relit l'attente seule et termine dès la confirmation", async () => {
  const previousFetch = globalThis.fetch;
  const waits: number[] = [];
  const pending = { status: 202, body: { pending: true, error: SETTLEMENT_FINALITY_PENDING_FAST } };
  const answers: { status: number; body: object }[] = [pending, pending, { status: 200, body: { loanId: "loan-fast" } }];
  globalThis.fetch = (async () => {
    const answer = answers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  let issued = 0;
  const grant: typeof issueRunnerGrant = async () => ({ grant: `grant-${issued++}` }) as never;
  try {
    await settleLoan("loan-fast", "receipt", { grant, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, SETTLEMENT_PENDING_RETRY_MS.slice(0, 2));
    assert.ok(SETTLEMENT_PENDING_RETRY_MS.every((ms) => ms >= 5_000), "au plus 10 essais par minute, quota de la route");

    // Attente rapide qui dure : le message remonte après les relectures prévues.
    answers.push(...Array.from({ length: SETTLEMENT_PENDING_RETRY_MS.length + 1 }, () => pending));
    await assert.rejects(settleLoan("loan-fast", "receipt", { grant, wait: async () => {} }), { message: SETTLEMENT_FINALITY_PENDING_FAST });
    assert.equal(answers.length, 0);

    // Palier long (un quart d'heure) : aucune relecture, la page affiche l'attente.
    answers.push({ status: 202, body: { pending: true, error: SETTLEMENT_FINALITY_PENDING } });
    await assert.rejects(settleLoan("loan-slow", "receipt", { grant, wait: async () => assert.fail("pas de relance") }),
      { message: SETTLEMENT_FINALITY_PENDING });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("une attente de règlement s'affiche en information, jamais en erreur", () => {
  assert.equal(isSettlementPending(SETTLEMENT_FINALITY_PENDING), true);
  assert.equal(isSettlementPending(SETTLEMENT_FINALITY_PENDING_FAST), true);
  assert.equal(isSettlementPending(SETTLEMENT_QUEUED), false);
  const page = readFileSync(join(process.cwd(), "src/app/(app)/train/page.tsx"), "utf8");
  assert.match(page, /isSettlementPending\(message\)\) setNotice\(message\)/);
  assert.match(page, /role="status"[^>]*data-testid="settlement-pending"/);
});

test("PAR-02 : côté serveur, seul le refus « wallet runner occupé » (503) devient le message de règlement en file", () => {
  assert.equal((settlementQueuedError(new AppError(RUNNER_WALLET_BUSY, 503)) as Error).message, SETTLEMENT_QUEUED);
  const conflict = new AppError(RUNNER_WALLET_BUSY, 409);
  assert.equal(settlementQueuedError(conflict), conflict);
  const unavailable = new AppError("Runner confidentiel indisponible", 503);
  assert.equal(settlementQueuedError(unavailable), unavailable);
});
