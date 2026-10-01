import { afterEach, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, type Hex } from "viem";
import type { Loan } from "@/generated/prisma/client";
import { loanKeyFor } from "@/lib/evm/loan-key";
import { lockUsdcTransaction, refundEscrowTransaction } from "@/lib/evm/transaction";
import { siriusescrowAbi } from "@/lib/evm/abi/siriusescrow";
import { trainingProfileHash } from "@/lib/models/registry";

const ESCROW = `0x${"11".repeat(20)}` as Hex;
const OLD_ESCROW = `0x${"44".repeat(20)}` as Hex;
const BORROWER = `0x${"22".repeat(20)}`;
const PROVIDER = `0x${"33".repeat(20)}`;
const HASH = `0x${"aa".repeat(32)}` as Hex;
const DATASET = `0x${"bb".repeat(32)}` as Hex;
const MODEL = { modelId: "linear_regression", modelVersion: "1.0.0" } as const;
let prisma: typeof import("@/lib/db").prisma;
let client: ReturnType<typeof import("@/lib/evm/client").getPublicClient>;
let recover: typeof import("./recover-loan").recoverUnsubmittedLoan;
let cancel: typeof import("./cancel").cancelExpiredLoan;
let reap: typeof import("./reaper").runLoanReaper;
let checkMigration: typeof import("./migration-check").checkEvmMigration;
let finalize: typeof import("./borrower").finalizeLoan;
let checkUpgrade: typeof import("./escrow-upgrade").checkEscrowUpgrade;
let status = 1;
let updates: { where: Record<string, unknown>; data: Record<string, unknown> }[];
const restoreDb: (() => void)[] = [];

function stubDb(target: object, key: string, implementation: unknown) {
  const original = Reflect.get(target, key);
  Reflect.set(target, key, implementation);
  restoreDb.push(() => { Reflect.set(target, key, original); });
}

function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: "loan-1", datasetId: "dataset-1", borrower: BORROWER, provider: PROVIDER,
    status: "PENDING", amountUsdcAtomic: "1000000000000000000", challengeDays: 7,
    ...MODEL, evmLoanKey: loanKeyFor(BORROWER, "loan-1"), evmHashlock: HASH,
    evmChainId: 46630, evmEscrowAddress: ESCROW, evmPreparedBlock: "9",
    evmLockTxHash: HASH, evmLockBlock: "10", evmDeadline: new Date(1000),
    updatedAt: new Date(0), createdAt: new Date(0), cancelTxHash: null,
    runnerReceipt: null, attestationPayload: null, ...overrides,
  } as Loan;
}

function onChain() {
  return { provider: PROVIDER, borrower: BORROWER, amount: BigInt("1000000000000000000"),
    deadline: BigInt(1), status, hashlock: HASH, preimage: HASH, datasetId: DATASET,
    trainingProfile: trainingProfileHash(MODEL) };
}

function transaction(to = ESCROW) {
  return { hash: HASH, from: BORROWER, to, input: lockUsdcTransaction({
    provider: PROVIDER, datasetId: DATASET, amount: loan().amountUsdcAtomic,
    hashlock: HASH, challengeDays: 7, loanId: "loan-1", trainingProfile: trainingProfileHash(MODEL),
    authorization: { deadline: 300, signature: "0x" },
  }).data };
}

before(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  ({ prisma } = await import("@/lib/db"));
  client = (await import("@/lib/evm/client")).getPublicClient();
  ({ recoverUnsubmittedLoan: recover } = await import("./recover-loan"));
  ({ cancelExpiredLoan: cancel } = await import("./cancel"));
  ({ runLoanReaper: reap } = await import("./reaper"));
  ({ checkEvmMigration: checkMigration } = await import("./migration-check"));
  ({ finalizeLoan: finalize } = await import("./borrower"));
  ({ checkEscrowUpgrade: checkUpgrade } = await import("./escrow-upgrade"));
});

beforeEach(() => {
  process.env.EVM_NETWORK = "testnet";
  process.env.SIRIUS_ESCROW_ADDRESS = ESCROW;
  process.env.SIRIUS_DATASET_ADDRESS = PROVIDER;
  process.env.SIRIUS_LEGACY_ESCROW_ADDRESSES = "";
  process.env.TEE_MODE = "phala";
  status = 1;
  updates = [];
  mock.method(client, "readContract", async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === "VERSION") return address.toLowerCase() === PROVIDER ? "sirius-dataset-v4" : "sirius-escrow-usdc-v6";
    if (functionName === "datasets") return PROVIDER;
    if (functionName === "escrow") return ESCROW;
    return onChain();
  });
  mock.method(client, "getChainId", async () => 46630);
  mock.method(client, "getTransaction", async () => transaction());
  mock.method(client, "getTransactionReceipt", async () => ({ status: "success", blockNumber: BigInt(10) }));
  mock.method(client, "waitForTransactionReceipt", async () => ({ status: "success", blockNumber: BigInt(10) }));
  mock.method(client, "getLogs", async () => [{ transactionHash: HASH }]);
  stubDb(prisma.loan, "findUnique", async () => loan({ status: "ESCROWED" }));
  stubDb(prisma.loan, "updateMany", async (args: typeof updates[number]) => { updates.push(args); return { count: 1 }; });
  stubDb(prisma.dataset, "findUnique", async () => ({ evmDatasetId: DATASET, evmMintBlock: "8" }));
});

afterEach(() => {
  mock.restoreAll();
  while (restoreDb.length) restoreDb.pop()!();
});

test("le préflight v6 bloque les prêts et locks historiques même après les migrations Prisma", async () => {
  process.env.SIRIUS_LEGACY_ESCROW_ADDRESSES = OLD_ESCROW;
  let historicalAddress = OLD_ESCROW;
  let pending = 0;
  let unbound = 0;
  let locked = BigInt(0);
  stubDb(prisma.loan, "findMany", async () => [{ evmEscrowAddress: historicalAddress, evmChainId: 46630 }]);
  stubDb(prisma.loan, "count", async ({ where }: { where: Record<string, unknown> }) => where.AND ? unbound : pending);
  mock.method(client, "readContract", async ({ address, functionName }: { address: string; functionName: string }) => {
    if (functionName === "VERSION") return address.toLowerCase() === PROVIDER ? "sirius-dataset-v4" : "sirius-escrow-usdc-v6";
    if (functionName === "datasets") return PROVIDER;
    if (functionName === "escrow") return ESCROW;
    if (functionName === "accounting") return [locked, BigInt(0), locked, BigInt(0)];
    throw new Error(functionName);
  });
  await checkUpgrade();
  unbound = 1;
  await assert.rejects(checkUpgrade(), /sans déploiement, même clôturés/);
  unbound = 0;
  pending = 1;
  await assert.rejects(checkUpgrade(), /terminer les prêts/);
  pending = 0;
  locked = BigInt(1);
  await assert.rejects(checkUpgrade(), /fonds encore verrouillés/);
  locked = BigInt(0);
  historicalAddress = PROVIDER as Hex;
  await assert.rejects(checkUpgrade(), /historique non déclaré/);
});

test("récupère un lock confirmé avec son déploiement", async () => {
  await recover(loan());
  assert.equal(updates[0]?.data.status, "ESCROWED");
  assert.equal(updates[0]?.data.evmEscrowAddress, ESCROW);
  assert.equal(updates[0]?.data.evmLockBlock, "10");
});

test("une panne RPC ne déclenche aucune annulation", async () => {
  mock.method(client, "readContract", async () => { throw new Error("RPC indisponible"); });
  await assert.rejects(() => recover(loan()), /RPC/);
  assert.equal(updates.length, 0);
});

test("un hash en attente de reçu ne peut pas être annulé", async () => {
  status = 0;
  mock.method(client, "getTransactionReceipt", async () => { throw new Error("reçu absent"); });
  await assert.rejects(() => recover(loan()), /reçu absent/);
  assert.equal(updates.length, 0);
});

test("retrouve le hash d'un lock depuis le bloc de préparation", async () => {
  mock.method(client, "getBlockNumber", async () => BigInt(20));
  mock.method(client, "request", async ({ params }: { params: { fromBlock: string; topics: unknown[] }[] }) => {
    assert.equal(params[0].fromBlock, "0x9");
    assert.equal(params[0].topics[1], loan().evmLoanKey);
    return [{ transactionHash: HASH }];
  });
  await recover(loan({ evmLockTxHash: null }));
  assert.equal(updates[0]?.data.evmLockTxHash, HASH);
});

test("un ancien PENDING sans métadonnées est vérifié sur tous les escrows autorisés", async () => {
  process.env.SIRIUS_LEGACY_ESCROW_ADDRESSES = OLD_ESCROW;
  const visited = new Set<string>();
  mock.method(client, "readContract", async ({ address, functionName }: { address: string; functionName: string }) => {
    visited.add(address);
    return functionName === "VERSION" ? "sirius-escrow-usdc-v5" : { ...onChain(), status: 0 };
  });
  await recover(loan({ evmChainId: null, evmEscrowAddress: null, evmLockTxHash: null }));
  assert.deepEqual(visited, new Set([ESCROW, OLD_ESCROW]));
  assert.deepEqual(updates[0]?.data, { status: "CANCELLED" });
});

test("récupère un ancien lock sans hash ni binding depuis le bloc du dataset", async () => {
  process.env.SIRIUS_LEGACY_ESCROW_ADDRESSES = OLD_ESCROW;
  mock.method(client, "readContract", async ({ address, functionName }: { address: string; functionName: string }) =>
    functionName === "VERSION" ? "sirius-escrow-usdc-v5" : { ...onChain(), status: address === OLD_ESCROW ? 1 : 0 });
  mock.method(client, "getTransaction", async () => transaction(OLD_ESCROW));
  mock.method(client, "getBlockNumber", async () => BigInt(20));
  mock.method(client, "request", async ({ params }: { params: { address: string; fromBlock: string }[] }) => {
    assert.equal(params[0].address, OLD_ESCROW);
    assert.equal(params[0].fromBlock, "0x8");
    return [{ transactionHash: HASH }];
  });
  await recover(loan({ evmChainId: null, evmEscrowAddress: null, evmLockTxHash: null, evmPreparedBlock: null }));
  assert.equal(updates[0]?.data.evmEscrowAddress, OLD_ESCROW);
  assert.equal(updates[0]?.data.status, "ESCROWED");
});

test("réactive un prêt annulé localement mais réellement payé", async () => {
  await recover(loan({ status: "CANCELLED" }));
  assert.equal(updates[0]?.data.status, "ESCROWED");
});

test("refuse une transaction du même borrower mais étrangère au lock", async () => {
  mock.method(client, "getTransaction", async () => ({ ...transaction(), input: "0x" }));
  await assert.rejects(() => recover(loan()));
  assert.equal(updates.length, 0);
});

test("le remboursement Phala est signé par le wallet puis confirmé on-chain", async () => {
  const first = await cancel("loan-1", BORROWER);
  assert.ok(first.transaction);
  assert.equal(first.transaction.to, ESCROW);
  const decoded = decodeFunctionData({ abi: siriusescrowAbi, data: first.transaction.data });
  assert.equal(decoded.functionName, "refund");
  assert.deepEqual(decoded.args, [loan().evmLoanKey]);
  assert.equal(updates.length, 0);
  status = 3;
  const confirmed = await cancel("loan-1", BORROWER);
  assert.equal(confirmed.status, "CANCELLED");
  assert.equal(updates[0]?.data.cancelTxHash, HASH);
});

test("le reaper dépasse un premier lot de 50 prêts actifs", async () => {
  const cursors: unknown[] = [];
  stubDb(prisma.loan, "findMany", async ({ where }: { where: { id?: { gt: string } } }) => {
    cursors.push(where.id);
    return where.id ? [loan({ id: "z-pending", evmLoanKey: null })]
      : Array.from({ length: 50 }, (_, i) => loan({ id: `a-${String(i).padStart(2, "0")}`, status: "ESCROWED" }));
  });
  await reap();
  await reap();
  assert.deepEqual(cursors, [undefined, { gt: "a-49" }]);
  assert.equal(updates.at(-1)?.where.id, "z-pending");
});

test("la migration bloque aussi un CANCELLED qui possède encore un escrow actif", async () => {
  process.env.SIRIUS_MIGRATION_ESCROW_ADDRESSES = ESCROW;
  let call = 0;
  stubDb(prisma, "$queryRaw", async () => ++call === 1 ? [{ present: true }]
    : call === 2 ? [{ present: false }]
      : [{ id: "cancelled-1", evmLoanKey: loan().evmLoanKey, evmLockTxHash: null }]);
  await assert.rejects(() => checkMigration(), /escrow encore actif/);
  assert.equal(updates.length, 0);
});

test("le préflight situe une panne SQL avant tout appel au RPC", async () => {
  const steps: string[] = [];
  const failure = Object.assign(new Error("SECRET_SYNTHETIQUE"), { code: "42P01" });
  let reads = 0;
  stubDb(prisma, "$queryRaw", async () => {
    if (++reads === 1) return [{ present: true }];
    throw failure;
  });
  mock.method(client, "getChainId", async () => assert.fail("Le RPC ne doit pas être appelé après une panne SQL"));
  await assert.rejects(() => checkMigration((step) => steps.push(step)), (error) => error === failure);
  // La garde de chaîne est la première lecture après la détection de la table Loan.
  assert.equal(steps.at(-1), "PostgreSQL : contrôle de la chaîne des données (testnet, 46630)");
  assert.ok(!steps.join(" ").includes("SECRET_SYNTHETIQUE"));
  assert.equal(updates.length, 0);
});

test("une erreur de règlement ne divulgue pas le préimage dans les logs", async () => {
  process.env.TEE_MODE = "stub";
  process.env.SIRIUS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  const preimage = `0x${"de".repeat(32)}` as Hex;
  const logs: unknown[][] = [];
  mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  mock.method(client, "simulateContract", async () => { throw new Error(`calldata release(${preimage})`); });
  const { settleEscrow } = await import("@/lib/evm/escrow");
  await assert.rejects(() => settleEscrow(loan().evmLoanKey as Hex, preimage, BigInt(10)), /Règlement on-chain du runner échoué/);
  assert.deepEqual(logs, [["[evm] release échouée"]]);
  assert.ok(!JSON.stringify(logs).includes(preimage));
});

function submittedLoan(overrides: Partial<Loan> = {}) {
  return { ...loan(overrides), dataset: { evmDatasetId: DATASET, wrappedKey: "wrapped", runnerReceipt: "receipt" } };
}

test("la soumission refuse une autre opération du même contrat et libère le mauvais hash", async () => {
  stubDb(prisma.loan, "findUnique", async () => submittedLoan());
  mock.method(client, "getTransaction", async () => ({ ...transaction(), input: refundEscrowTransaction(HASH, ESCROW).data }));
  await assert.rejects(() => finalize("loan-1", BORROWER), /étrangère au lock/);
  assert.equal(updates[0]?.data.status, "SUBMITTING");
  assert.deepEqual(updates.at(-1)?.data, { status: "PENDING", evmLockTxHash: null });
  assert.equal(updates.at(-1)?.where.evmLockTxHash, HASH);
});

test("un timeout de confirmation conserve le hash soumis", async () => {
  stubDb(prisma.loan, "findUnique", async () => submittedLoan());
  mock.method(client, "waitForTransactionReceipt", async () => { throw new Error("timeout"); });
  await assert.rejects(() => finalize("loan-1", BORROWER), /timeout/);
  assert.deepEqual(updates.map((u) => u.data), [{ status: "SUBMITTING", evmLockTxHash: HASH }]);
});

test("un mauvais hash existant peut être remplacé uniquement par un lock confirmé du même prêt", async () => {
  const correctHash = `0x${"cc".repeat(32)}` as Hex;
  stubDb(prisma.loan, "findUnique", async () => submittedLoan({ status: "SUBMITTING" }));
  stubDb(prisma.loan, "findUniqueOrThrow", async () => loan({ status: "ESCROWED", evmLockTxHash: correctHash }));
  mock.method(client, "getTransaction", async () => ({ ...transaction(), hash: correctHash }));
  const result = await finalize("loan-1", BORROWER, correctHash);
  assert.equal(result.evmLockTxHash, correctHash);
  assert.equal(updates[0]?.data.evmLockTxHash, correctHash);
  assert.equal(updates[0]?.data.status, "ESCROWED");
});

test("un remplacement de hash pending ou étranger ne remplace aucune preuve existante", async () => {
  const correctHash = `0x${"cc".repeat(32)}` as Hex;
  stubDb(prisma.loan, "findUnique", async () => submittedLoan({ status: "SUBMITTING" }));
  mock.method(client, "getTransaction", async () => ({ ...transaction(), hash: correctHash }));
  const pending = mock.method(client, "getTransactionReceipt", async () => { throw new Error("pending"); });
  await assert.rejects(() => finalize("loan-1", BORROWER, correctHash), /pending/);
  pending.mock.restore();
  mock.method(client, "getTransaction", async () => ({ ...transaction(), hash: correctHash, input: refundEscrowTransaction(HASH, ESCROW).data }));
  await assert.rejects(() => finalize("loan-1", BORROWER, correctHash), /étrangère au lock/);
  assert.equal(updates.length, 0);
});

test("une reprise historique n'annonce pas un succès si la mise à jour concurrente a échoué", async () => {
  stubDb(prisma.loan, "findUnique", async () => submittedLoan({ evmEscrowAddress: null, evmChainId: null }));
  stubDb(prisma.loan, "updateMany", async () => ({ count: 0 }));
  await assert.rejects(() => finalize("loan-1", BORROWER), /Réconciliation concurrente/);
});

test("un remplacement rejeté ne peut pas annuler un autre lock encore en attente", async () => {
  const rejectedHash = `0x${"cc".repeat(32)}` as Hex;
  stubDb(prisma.loan, "findUnique", async () => submittedLoan({ status: "SUBMITTING" }));
  status = 0;
  mock.method(client, "getTransaction", async () => ({ ...transaction(), hash: rejectedHash }));
  mock.method(client, "getTransactionReceipt", async () => ({ status: "reverted", blockNumber: BigInt(10) }));
  await assert.rejects(() => finalize("loan-1", BORROWER, rejectedHash), /Lock USDC non confirmé/);
  assert.equal(updates.length, 0);
});

test("un ancien lock remboursé est reconnu comme une réconciliation réussie", async () => {
  status = 3;
  stubDb(prisma.loan, "findUnique", async () => submittedLoan({ evmChainId: null, evmEscrowAddress: null }));
  stubDb(prisma.loan, "findUniqueOrThrow", async () => loan({ status: "CANCELLED", cancelTxHash: HASH }));
  const result = await finalize("loan-1", BORROWER);
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.cancelTxHash, HASH);
  assert.equal(updates[0]?.data.cancelTxHash, HASH);
});

test("le préflight bloque une transaction connue encore en attente même sur un CANCELLED", async () => {
  process.env.SIRIUS_MIGRATION_ESCROW_ADDRESSES = ESCROW;
  let call = 0;
  stubDb(prisma, "$queryRaw", async () => ++call === 1 ? [{ present: true }]
    : call === 2 ? [{ present: false }]
      : [{ id: "pending-lock", evmLoanKey: loan().evmLoanKey, evmLockTxHash: HASH }]);
  status = 0;
  mock.method(client, "getTransactionReceipt", async () => { throw new Error("pending"); });
  await assert.rejects(() => checkMigration(), /lock non confirmée/);
  assert.equal(updates.length, 0);
});

test("le préflight refuse un schéma PostgreSQL non supporté avant toute lecture", async () => {
  const url = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `${url}?schema=staging`;
  try {
    await assert.rejects(() => checkMigration(), /seul le schéma PostgreSQL public/);
  } finally {
    process.env.DATABASE_URL = url;
  }
});

test("les logs de réconciliation et les réponses API ne divulguent pas les jetons RPC", async () => {
  const token = "AUDIT_SYNTHETIC_RPC_TOKEN";
  const rpcError = Object.assign(new Error(`RPC https://rpc.example.invalid/v2/${token}`), { url: `https://rpc.example.invalid/v2/${token}` });
  const logs: unknown[][] = [];
  mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  mock.method(client, "getTransaction", async () => { throw rpcError; });
  stubDb(prisma.loan, "findMany", async () => [loan()]);
  await reap();
  const { errorResponse } = await import("@/lib/errors");
  const response = errorResponse(rpcError);
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(token));
  assert.deepEqual(logs, [["[reaper] prêt EVM loan-1 non réconcilié"], ["[api] erreur interne (Error)"]]);
});

test("une panne de base du reaper planifié est capturée et la passe suivante reprend", async () => {
  const callbacks: (() => void)[] = [];
  const logs: unknown[][] = [];
  mock.method(globalThis, "setInterval", (callback: () => void) => {
    callbacks.push(callback);
    return { unref() {} };
  });
  mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  let calls = 0;
  stubDb(prisma.loan, "findMany", async () => {
    if (++calls === 1) throw new Error("base indisponible");
    return [];
  });
  const { startLoanReaper } = await import("./reaper");
  startLoanReaper();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(logs, [["[reaper] passe indisponible, reprise à la suivante"]]);
  callbacks[0]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

function billedReaperFixture(terminalStatus: number) {
  process.env.SIRIUS_EVM_FINALITY = "confirmations";
  process.env.SIRIUS_EVM_CONFIRMATIONS = "1";
  const current = loan({ status: "TRAINING", modelCid: null, billingQuoteHash: HASH });
  stubDb(prisma.loan, "findMany", async () => [current]);
  let recoveryReads = 0;
  stubDb(prisma.loan, "findUnique", async () => { recoveryReads++; throw new Error("runner indisponible"); });
  mock.method(client, "readContract", async ({ functionName }: { functionName: string }) => functionName === "VERSION"
    ? "sirius-escrow-usdc-v7"
    : { ...onChain(), status: terminalStatus, datasetAmount: BigInt(100), computeAmount: BigInt(40),
      maxFailureFee: BigInt(20), consumedCompute: BigInt(10), computeRecipient: PROVIDER, termsHash: HASH, lockedAt: BigInt(1) });
  mock.method(client, "getContractEvents", async () => [{ transactionHash: HASH }]);
  mock.method(client, "getTransactionReceipt", async () => ({ status: "success", transactionHash: HASH, to: ESCROW, blockNumber: BigInt(10), blockHash: HASH }));
  mock.method(client, "getBlockNumber", async () => BigInt(10));
  mock.method(client, "getBlock", async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: HASH }));
  mock.method(console, "error", () => {});
  return () => recoveryReads;
}

test("le reaper clôture un remboursement v7 canonique sans appeler la reprise en panne", async () => {
  const reads = billedReaperFixture(4);
  await reap();
  assert.equal(reads(), 0);
  assert.deepEqual(updates[0]?.data, { status: "CANCELLED", cancelTxHash: HASH, retainedFeeUsdcAtomic: "10", refundAmountUsdcAtomic: "130" });
  assert.equal(updates[0]?.where.status, "TRAINING");
});

test("un remboursement v7 non finalisé ou réorganisé ne clôture rien", async () => {
  const reads = billedReaperFixture(3);
  mock.method(client, "getBlock", async () => ({ number: BigInt(10), hash: DATASET }));
  await reap();
  assert.equal(reads(), 0);
  assert.equal(updates.length, 0);
});

test("un règlement v7 sans modèle conserve la récupération du résultat", async () => {
  const reads = billedReaperFixture(2);
  await reap();
  assert.equal(reads(), 1);
  assert.equal(updates.length, 0);
});

test("une panne RPC avant réconciliation v7 ne fabrique aucun remboursement", async () => {
  const reads = billedReaperFixture(3);
  mock.method(client, "readContract", async () => { throw new Error("RPC indisponible"); });
  await reap();
  assert.equal(reads(), 0);
  assert.equal(updates.length, 0);
});


test("un règlement v7 avec modèle passe encore par la validation de sa preuve", async () => {
  const reads = billedReaperFixture(2);
  stubDb(prisma.loan, "findMany", async () => [loan({ status: "TRAINING", modelCid: "model", billingQuoteHash: HASH })]);
  await reap();
  assert.equal(reads(), 1);
  assert.equal(updates.length, 0);
});
