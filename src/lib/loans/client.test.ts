import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ENCLAVE_STARTING_MESSAGE } from "@/lib/train/enclave-wait";
import {
  borrowDataset,
  finishPaidSettlement,
  PAID_SETTLEMENT_BUDGET_MS,
  PAID_SETTLEMENT_RETRY_MS,
  settleLoan,
  SETTLEMENT_PENDING_RETRY_MS,
  SETTLEMENT_QUEUED_RETRY_MS,
  type PaidSettlementProgress,
} from "./client";
import {
  API_ACCESS_PENDING,
  CALLS_PENDING,
  EXTENSION_PENDING,
  isSettlementPending,
  PACK_SETTLEMENT_BUSY,
  SETTLEMENT_FINALITY_PENDING,
  SETTLEMENT_FINALITY_PENDING_FAST,
  SETTLEMENT_QUEUED,
} from "./settlement-status";
import { ENCLAVE_STARTING_CODE } from "@/lib/train/enclave-wait";
import type { RunnerGrant } from "@/lib/runner/authorization-contract";
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
    await borrowDataset({ datasetId: "dataset-renew", priceUsdcAtomic: "100", rentalDays: 1 });
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
    await assert.rejects(borrowDataset({ datasetId: "dataset", priceUsdcAtomic: "100", rentalDays: 1 }), /Transaction de lock invalide/);
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
  const borrow = SOURCE.slice(SOURCE.indexOf("async function approveAndLock"), SOURCE.indexOf("export async function borrowDataset"));

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

test("règlement, enclave pas encore servie (audit E) : attente Retry-After sur place, puis message lisible au-delà de 10 min", async () => {
  const previousFetch = globalThis.fetch;
  const starting = { status: 503, body: { error: { code: "enclave_starting", message: "x" }, code: "enclave_starting", retryAfterSeconds: 45 } };
  const answers: { status: number; body: object }[] = [starting, starting, { status: 200, body: { loanId: "loan-wait" } }];
  globalThis.fetch = (async () => {
    const answer = answers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  let issued = 0;
  const grant: typeof issueRunnerGrant = async () => ({ grant: `grant-${issued++}` }) as never;
  try {
    const waits: number[] = [];
    await settleLoan("loan-wait", "receipt", { grant, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, [45_000, 45_000]);
    assert.equal(issued, 3, "un grant neuf par essai");
    answers.push(...Array.from({ length: 20 }, () => starting));
    await assert.rejects(settleLoan("loan-wait", "receipt", { grant, wait: async () => {} }), { message: ENCLAVE_STARTING_MESSAGE });
    assert.equal(answers.length, 20 - 14, "13 attentes de 45 s tiennent dans 10 min, la 14e réponse remonte");
    answers.length = 0;
    // Contrôleur muet : message lisible, aucune relance.
    answers.push({ status: 503, body: { error: "Gestion de l’enclave momentanément indisponible : réessaie dans quelques minutes", code: "controller_unavailable" } });
    await assert.rejects(settleLoan("loan-wait", "receipt", { grant, wait: async () => assert.fail("pas de relance") }),
      { message: "Gestion de l’enclave momentanément indisponible : réessaie dans quelques minutes" });
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

type Answer = { status: number; body: object } | "network";

/** Route de règlement simulée : réponses dans l'ordre, corps et instants de chaque essai relevés. */
function paidSettlementRoute(answers: Answer[], clock: { now: number }) {
  const previousFetch = globalThis.fetch;
  const calls: { body: string; at: number }[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push({ body: init.body, at: clock.now });
    const answer = answers.shift();
    if (!answer) throw new Error("essai de trop");
    if (answer === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  let issued = 0;
  const request = {
    url: "/api/loans/origin/calls",
    grant: async () => ({ nonce: `grant-${issued++}` }) as unknown as RunnerGrant,
    body: (authorization: RunnerGrant) => ({ packLoanId: "pack", authorization }),
    failure: "Achat d’appels échoué",
  };
  return { calls, request, restore: () => { globalThis.fetch = previousFetch; } };
}

function fakeTime() {
  const clock = { now: 0 };
  const waits: number[] = [];
  return { clock, waits, now: () => clock.now, wait: async (ms: number) => { waits.push(ms); clock.now += ms; } };
}

test("achat payé : la page rejoue le règlement en attente, une autorisation neuve à chaque essai, jusqu'à l'activation", async () => {
  const time = fakeTime();
  const route = paidSettlementRoute([
    { status: 409, body: { error: CALLS_PENDING } },
    { status: 503, body: { error: SETTLEMENT_QUEUED } },
    { status: 409, body: { error: PACK_SETTLEMENT_BUSY } },
    { status: 429, body: { error: "Trop de requêtes — réessaie plus tard" } },
    "network",
    { status: 202, body: { pending: true, error: API_ACCESS_PENDING } },
    { status: 200, body: { loanId: "pack", credits: 1000 } },
  ], time.clock);
  const reported: PaidSettlementProgress[] = [];
  try {
    const outcome = await finishPaidSettlement(route.request, { onProgress: (progress) => reported.push(progress), wait: time.wait, now: time.now });
    assert.equal(outcome, "settled");
    assert.deepEqual(reported.map((progress) => progress.stage), ["confirming", "activating"], "409 : confirmation du lock ; 202 : release envoyé");
    assert.ok(reported.every((progress) => progress.enclaveRetryInSeconds === null));
    assert.equal(route.calls.length, 7);
    assert.equal(new Set(route.calls.map((call) => call.body)).size, 7, "chaque essai porte son propre grant");
    assert.ok(route.calls.every((call) => JSON.parse(call.body).packLoanId === "pack"), "toujours le même règlement");
    assert.deepEqual(time.waits, Array(6).fill(PAID_SETTLEMENT_RETRY_MS));
  } finally {
    route.restore();
  }
});

test("achat payé : attente qui dure, la page s'arrête au budget et laisse le reaper terminer, sous le quota de la route", async () => {
  const time = fakeTime();
  const pending = { status: 409, body: { error: EXTENSION_PENDING } };
  const route = paidSettlementRoute(Array.from({ length: 40 }, () => pending), time.clock);
  try {
    assert.equal(await finishPaidSettlement(route.request, { wait: time.wait, now: time.now }), "deferred");
    assert.equal(route.calls.length, PAID_SETTLEMENT_BUDGET_MS / PAID_SETTLEMENT_RETRY_MS + 1);
    assert.ok(route.calls.at(-1)!.at <= PAID_SETTLEMENT_BUDGET_MS);
    // Route : 10 règlements par minute et par compte, packs et passes confondus.
    for (const call of route.calls) {
      assert.ok(route.calls.filter((other) => other.at >= call.at && other.at < call.at + 60_000).length <= 6);
    }
  } finally {
    route.restore();
  }
});

test("achat payé : une erreur définitive s'affiche aussitôt, sans autre essai", async () => {
  const time = fakeTime();
  const route = paidSettlementRoute([
    { status: 409, body: { error: CALLS_PENDING } },
    { status: 404, body: { error: "Pack d’appels introuvable" } },
  ], time.clock);
  try {
    await assert.rejects(finishPaidSettlement(route.request, { wait: time.wait, now: time.now }), { message: "Pack d’appels introuvable" });
    assert.equal(route.calls.length, 2);
    assert.deepEqual(time.waits, [PAID_SETTLEMENT_RETRY_MS]);
  } finally {
    route.restore();
  }
});

test("achat payé : composant démonté, l'attente est coupée et plus aucun essai ne part", async () => {
  const controller = new AbortController();
  const route = paidSettlementRoute([{ status: 409, body: { error: CALLS_PENDING } }], { now: 0 });
  try {
    // Attente réelle de 10 s (`abortableSleep`) : le démontage la coupe.
    const settling = finishPaidSettlement(route.request, { signal: controller.signal });
    while (route.calls.length === 0) await tick();
    await tick();
    controller.abort(new Error("démonté"));
    await assert.rejects(settling, /démonté/);
    assert.equal(route.calls.length, 1);
  } finally {
    route.restore();
  }
});

test("achat payé : enclave en démarrage, attente annoncée comme suite du paiement, Retry-After dans le même budget", async () => {
  const time = fakeTime();
  const starting = { status: 503, body: { error: { code: ENCLAVE_STARTING_CODE, message: "L’enclave démarre." }, retryAfterSeconds: 30 } };
  const route = paidSettlementRoute([starting, { status: 409, body: { error: CALLS_PENDING } }, { status: 200, body: {} }], time.clock);
  const reported: PaidSettlementProgress[] = [];
  try {
    // Seul canal de l'attente après paiement : l'avancement du règlement, jamais celui d'avant paiement
    // (`retryWhileEnclaveStarts`, « rien n'est payé »), ni une `EnclaveStartingError` levée.
    const outcome = await finishPaidSettlement(route.request, { onProgress: (progress) => reported.push(progress), wait: time.wait, now: time.now });
    assert.equal(outcome, "settled");
    assert.deepEqual(time.waits, [30_000, PAID_SETTLEMENT_RETRY_MS]);
    assert.deepEqual(reported, [
      { stage: "confirming", enclaveRetryInSeconds: null },
      { stage: "confirming", enclaveRetryInSeconds: 30 },
      { stage: "confirming", enclaveRetryInSeconds: null },
    ]);
  } finally {
    route.restore();
  }

  // Démarrage qui dure : les attentes de l'enclave consomment le budget de la page, sans le prolonger.
  const late = fakeTime();
  const slow = paidSettlementRoute(Array.from({ length: 20 }, () => starting), late.clock);
  try {
    assert.equal(await finishPaidSettlement(slow.request, { wait: late.wait, now: late.now }), "deferred");
    assert.equal(slow.calls.length, PAID_SETTLEMENT_BUDGET_MS / 30_000 + 1);
  } finally {
    slow.restore();
  }
});
