import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync, chmodSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keccak256, type Hex } from "viem";
import { BudgetLedger, initializeBudgetLedger, validateBudgetPolicy, type BudgetPolicy } from "./budget-ledger";
import { budgetFingerprint, runBudgetedOperation, runnerBudget } from "./budget";
import { sendBudgetedTransaction, type BudgetedTransactionIO } from "./budget-transaction";
import { boundedGas } from "./gas-policy";
import { reconcileRunnerTransactions } from "./transaction-recovery";
import type { PublicClient } from "viem";

const wallet = `0x${"12".repeat(20)}`;
const directories: string[] = [];
const ledgers: BudgetLedger[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function policy(): BudgetPolicy {
  return {
    version: 1, chainId: 46630, wallet, accountingReference: "fixture-synthetic-not-revenue", validUntil: Date.now() + 60_000,
    earnedMarginUsdMicros: "1000", cashUsdMicros: "1000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 8,
  };
}

function fixture(change: (p: BudgetPolicy) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "sirius-budget-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const path = join(directory, "ledger.sqlite");
  const p = policy();
  change(p);
  initializeBudgetLedger(path, p);
  function open() {
    const ledger = new BudgetLedger(path, p.chainId, wallet);
    ledgers.push(ledger);
    return ledger;
  }
  return { path, policy: p, ledger: open(), open };
}

test("ni liquidités seules, ni dépôts ou crédits futurs ne permettent d’admettre une dépense", () => {
  const { ledger } = fixture((p) => { p.earnedMarginUsdMicros = "0"; p.cashUsdMicros = "1000000000"; });
  assert.throws(() => ledger.reserve("job", "scope", "training"), /Budget runner insuffisant/);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(0));
});

test("la réserve de frais fixes et les liquidités limitent toutes les identités clientes ensemble", () => {
  const { ledger } = fixture((p) => { p.cashUsdMicros = "250"; });
  ledger.reserve("wallet-a-job", "a", "training");
  assert.throws(() => ledger.reserve("wallet-b-job", "b", "training"), /Budget runner insuffisant/);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(100));
});

test("une réservation survit à une nouvelle connexion et ne peut changer de paramètres", () => {
  const { ledger, open } = fixture();
  assert.equal(ledger.reserve("job", "scope", "training").fresh, true);
  const restarted = open();
  assert.equal(restarted.reserve("job", "scope", "training").fresh, false);
  assert.throws(() => restarted.reserve("job", "other", "training"), /autres paramètres/);
  assert.equal(restarted.snapshot().allocatedUsd, BigInt(100));
});

test("succès et échec ne recréditent pas automatiquement le coût maximal réservé", () => {
  const { ledger } = fixture();
  ledger.reserve("a", "a", "training");
  ledger.reserve("b", "b", "training");
  ledger.finish("a", "a", true, "{}");
  ledger.finish("b", "b", false);
  ledger.finish("b", "b", false);
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(200), allocatedWei: BigInt(0), failures: 1 });
});

test("les échecs ouvrent un coupe-circuit durable, même après un succès", () => {
  const { ledger, open } = fixture((p) => { p.maxFailures = 1; });
  ledger.reserve("good", "good", "training");
  ledger.reserve("bad", "bad", "training");
  ledger.finish("bad", "bad", false);
  ledger.finish("good", "good", true);
  assert.throws(() => open().reserve("new", "new", "request"), /Coupe-circuit/);
});

test("une politique périmée bloque les nouveaux coûts et conserve les opérations existantes", () => {
  const { ledger } = fixture((p) => { p.validUntil = Date.now() - 1; });
  assert.throws(() => ledger.reserve("job", "scope", "training"), /périmée/);
});

test("un registre absent, corrompu, remplacé ou lié à une autre identité ne devient pas vide", () => {
  const { ledger, path } = fixture();
  assert.throws(() => initializeBudgetLedger(path, policy()), /EEXIST/);
  assert.throws(() => new BudgetLedger(path, 4663, wallet), /autre réseau/);
  assert.throws(() => new BudgetLedger(`${path}.missing`, 46630, wallet), /ENOENT/);
  renameSync(path, `${path}.old`);
  writeFileSync(path, "invalid", { mode: 0o600 });
  assert.throws(() => ledger.reserve("a", "a", "request"), /remplacé/);
  assert.throws(() => new BudgetLedger(path, 46630, wallet));
});

test("les registres accessibles aux autres utilisateurs et les budgets mal formés sont refusés", () => {
  const { path } = fixture();
  chmodSync(path, 0o644);
  assert.throws(() => new BudgetLedger(path, 46630, wallet), /privé/);
  for (const invalid of ["-1", "1.2", "1e6", 100, "", "01"]) {
    assert.throws(() => validateBudgetPolicy({ ...policy(), earnedMarginUsdMicros: invalid }), /invalide/);
  }
});

test("les compteurs en unités entières restent exacts au-delà de Number.MAX_SAFE_INTEGER", () => {
  const amount = "900719925474099300";
  const { ledger } = fixture((p) => {
    p.earnedMarginUsdMicros = p.cashUsdMicros = amount;
    p.fixedReserveUsdMicros = "0";
    p.costsUsdMicros.training = amount;
  });
  ledger.reserve("a", "a", "training");
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(amount));
  assert.throws(() => ledger.reserve("b", "b", "request"), /insuffisant/);
});

test("deux processus ne peuvent réserver simultanément la dernière marge disponible", async () => {
  const { path, ledger } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "200"; });
  const script = `import { BudgetLedger } from ${JSON.stringify(resolve("src/lib/runner/budget-ledger.ts"))};
    const ledger = new BudgetLedger(process.argv[1], 46630, ${JSON.stringify(wallet)});
    try { ledger.reserve(process.argv[2], process.argv[2], 'training'); process.stdout.write('admitted'); }
    catch { process.stdout.write('blocked'); } finally { ledger.close(); }`;
  const run = promisify(execFile);
  const results = await Promise.all(["first", "second"].map((id) => run(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, path, id])));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ["admitted", "blocked"]);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(100));
});

test("un job terminé restitue le même résultat sans calcul ou upload supplémentaire", async () => {
  const { ledger, open } = fixture();
  let calls = 0;
  const action = async () => { calls++; return { modelCid: "bafy-model", metrics: { mse: 1 } }; };
  const first = await runBudgetedOperation(ledger, "training", "job", "scope", action);
  const second = await runBudgetedOperation(open(), "training", "job", "scope", action);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("une reprise concurrente, interrompue ou échouée ne redémarre pas le calcul", async () => {
  const { ledger, open } = fixture();
  ledger.reserve("crash", "scope", "training");
  const unexpected = async () => { assert.fail("compute relancé"); };
  await assert.rejects(runBudgetedOperation(open(), "training", "crash", "scope", unexpected), /réconciliation/);
  await assert.rejects(runBudgetedOperation(ledger, "training", "failed", "scope", async () => { throw new Error("CPU timeout"); }), /CPU timeout/);
  await assert.rejects(runBudgetedOperation(open(), "training", "failed", "scope", unexpected), /réconciliation/);
});

test("la limite globale de concurrence persiste après interruption", () => {
  const { ledger, open } = fixture((p) => { p.maxActive = 1; });
  ledger.reserve("crash", "crash", "training");
  assert.throws(() => open().reserve("new", "new", "request"), /réconciliation/);
});

test("le fingerprint est indépendant de l’ordre des champs et lié au contenu", () => {
  assert.equal(budgetFingerprint({ a: 1, b: { c: 2, d: 3 } }), budgetFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(budgetFingerprint({ a: 1 }), budgetFingerprint({ a: 2 }));
});

test("l’absence de registre ne peut activer Phala, la production ou le mainnet", () => {
  delete process.env.RUNNER_BUDGET_FILE;
  Object.assign(process.env, { NODE_ENV: "test", TEE_MODE: "stub", EVM_NETWORK: "testnet" });
  assert.equal(runnerBudget(), null);
  for (const [key, value] of [["NODE_ENV", "production"], ["TEE_MODE", "phala"], ["EVM_NETWORK", "mainnet"]]) {
    const previous = process.env[key];
    process.env[key] = value;
    assert.throws(runnerBudget, /RUNNER_BUDGET_FILE obligatoire/);
    process.env[key] = previous;
  }
});

test("le handler et le calcul en processus refusent les opérations de production sans registre", async () => {
  delete process.env.RUNNER_BUDGET_FILE;
  Object.assign(process.env, { NODE_ENV: "production", TEE_MODE: "stub", EVM_NETWORK: "testnet" });
  const { handleRunnerOp } = await import("@/runner/handler");
  const { runTraining } = await import("@/lib/tee/core");
  await assert.rejects(handleRunnerOp("dataset-ingress-key", {}), /RUNNER_BUDGET_FILE obligatoire/);
  await assert.rejects(runTraining({
    datasetId: "test", cid: "bafy-test", wrappedKey: "unused", merkleRoot: "unused",
    priceUsdcAtomic: "1000", challengeDays: 1, modelId: "linear_regression", modelVersion: "1.0.0",
    keyContext: "synthetic", filename: "test.enc",
  }), /RUNNER_BUDGET_FILE obligatoire/);
});

const serialized: Hex = "0x02010203";
const txHash = keccak256(serialized);
function io(overrides: Partial<BudgetedTransactionIO> = {}): BudgetedTransactionIO {
  return {
    prepare: async () => ({ serialized, nonce: 7 }),
    send: async () => txHash,
    confirm: async () => "success",
    ...overrides,
  };
}

test("hash et nonce sont persistés avant envoi ; une reprise confirme sans signer ni renvoyer", async () => {
  const { ledger, open } = fixture();
  let sent = 0;
  await assert.rejects(sendBudgetedTransaction(ledger, "loan", "scope", io({
    send: async () => {
      const pending = open().find("loan", "scope");
      assert.equal(pending?.txHash, txHash);
      assert.equal(pending?.nonce, 7);
      sent++;
      throw new Error("RPC response lost");
    },
    confirm: async () => "pending",
  })), /incertaine/);
  assert.throws(() => open().reserve("other-loan", "other", "transaction"), /wallet runner encore incertaine/);
  const recovered = await sendBudgetedTransaction(open(), "loan", "scope", io({
    prepare: async () => { assert.fail("nouveau nonce"); },
    send: async () => { assert.fail("second envoi"); },
  }));
  assert.equal(recovered, txHash);
  assert.equal(sent, 1);
  assert.equal(ledger.snapshot().allocatedWei, BigInt(policy().gas.maxTransactionWei));
});

test("un crash avant persistance du hash interdit également de prendre un nouveau nonce", async () => {
  const { ledger, open } = fixture();
  ledger.reserve("loan", "scope", "transaction");
  await assert.rejects(sendBudgetedTransaction(open(), "loan", "scope", io({ prepare: async () => { assert.fail("signature après crash"); } })), /interrompue/);
  assert.throws(() => ledger.reserve("other", "other", "transaction"), /incertaine/);
});

test("une préparation refusée consomme sa tentative ; un revert n’est pas relancé", async () => {
  const { ledger } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "2000"; });
  await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io({ prepare: async () => { throw new Error("gas cap"); } })), /avant envoi/);
  await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io()), /épuisée/);
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io({ confirm: async () => "reverted" })), /aucune relance/);
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io()), /épuisée/);
  assert.equal(ledger.snapshot().failures, 2);
});

test("le plafond ETH cumulé reste consommé après confirmation", async () => {
  const { ledger } = fixture((p) => { p.gas.totalWei = p.gas.maxTransactionWei; });
  await sendBudgetedTransaction(ledger, "a", "a", io());
  await assert.rejects(sendBudgetedTransaction(ledger, "b", "b", io()), /insuffisant/);
});

test("une politique périmée pendant la préparation empêche l’envoi", async () => {
  const { ledger } = fixture();
  const originalNow = Date.now;
  try {
    await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io({
      prepare: async () => { Date.now = () => ledger.policy.validUntil + 1; return { serialized, nonce: 1 }; },
      send: async () => { assert.fail("envoi avec prix périmé"); },
    })), /périmée/);
    assert.equal(ledger.find("a", "a")?.state, "failed");
  } finally { Date.now = originalNow; }
});

test("une confirmation reste réconciliable après péremption de la politique", async () => {
  const { ledger, open } = fixture();
  await assert.rejects(sendBudgetedTransaction(ledger, "a", "a", io({ confirm: async () => "pending" })), /incertaine/);
  const originalNow = Date.now;
  try {
    Date.now = () => ledger.policy.validUntil + 1;
    assert.equal(await sendBudgetedTransaction(open(), "a", "a", io()), txHash);
  } finally { Date.now = originalNow; }
});

test("un reçu canonique finalisé libère une transaction réservée après timeout", async () => {
  const { ledger, open } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "2000"; });
  const escrow = `0x${"34".repeat(20)}`;
  const loanKey = `0x${"56".repeat(32)}`;
  const id = `release:46630:${escrow}:${loanKey}`;
  const input = "0x1234" as Hex;
  const fingerprint = keccak256(input);
  const hash = `0x${"78".repeat(32)}` as Hex;
  const blockHash = `0x${"9a".repeat(32)}`;
  ledger.reserve(id, fingerprint, "transaction");
  ledger.recordTransaction(id, fingerprint, hash, 7);
  const client = {
    getChainId: async () => 46630,
    getTransactionReceipt: async () => ({ blockNumber: BigInt(10), blockHash, transactionHash: hash,
      from: wallet, to: escrow, status: "success" }),
    getTransaction: async () => ({ from: wallet, to: escrow, nonce: 7, input }),
    getBlock: async () => ({ hash: blockHash }),
    getBlockNumber: async () => BigInt(11),
  } as unknown as PublicClient;
  await reconcileRunnerTransactions(open(), client, 46630, wallet as `0x${string}`);
  assert.equal(ledger.find(id, fingerprint)?.state, "succeeded");
  ledger.reserve("next", "next", "transaction");
});

test("le gas signé borne unités, prix, dépense et solde ETH", () => {
  const gas = policy().gas;
  assert.deepEqual(boundedGas(gas, BigInt(50000), BigInt(200000), BigInt(gas.maxTransactionWei)), {
    gas: BigInt(60000), maxFeePerGas: BigInt(400000),
  });
  for (const [units, price, balance] of [[100001, 1, 100000000000], [1, 1000001, 100000000000], [1, 1, 1], [0, 1, 100000000000]]) {
    assert.throws(() => boundedGas(gas, BigInt(units), BigInt(price), BigInt(balance)), /Plafond de gas/);
  }
  assert.throws(() => boundedGas({ ...gas, maxTransactionWei: "10" }, BigInt(100), BigInt(1), BigInt(1000)), /Plafond de gas/);
});

const workflow = { id: "loan:synthetic", fingerprint: "signed-quote" };
function workflowFixture() {
  return fixture((p) => {
    p.earnedMarginUsdMicros = p.cashUsdMicros = "10000";
    p.gas.totalWei = "1000000000000";
    p.maxFailures = 1;
  });
}

test("le devis réserve calcul, requêtes et deux transactions avant toute consommation", () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  const reserved = { allocatedUsd: BigInt(1116), allocatedWei: BigInt("200000000000"), failures: 0 };
  assert.deepEqual(ledger.snapshot(), reserved);
  const resumed = open();
  assert.equal(resumed.workflowPayload(workflow.id), "signed");
  resumed.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(0));
  resumed.reserve("training", "input", "training", workflow);
  resumed.finish("training", "input", true, "{}");
  for (const id of ["release", "failure"]) {
    resumed.reserve(id, id, "transaction", workflow);
    resumed.finish(id, id, true);
  }
  assert.deepEqual(ledger.snapshot(), reserved, "aucune double allocation ou marge recréée");
  assert.throws(() => resumed.reserve("third", "third", "transaction", workflow), /épuisé/);
  assert.throws(() => resumed.reserve("retry-training", "input", "training", workflow), /épuisé/);
});

test("un devis expiré jamais verrouillé restitue exactement son budget réservé", () => {
  const { ledger, open, policy: p } = workflowFixture();
  const payload = JSON.stringify({ quote: { expiresAt: Math.floor(Date.now() / 1000) - 1 } });
  ledger.reserveWorkflow(workflow, payload, p.validUntil, BigInt(p.gas.totalWei));
  assert.equal(open().expiredUnusedWorkflows(Date.now()).length, 1);
  assert.equal(open().releaseUnusedWorkflow(workflow), true);
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(0), allocatedWei: BigInt(0), failures: 0 });
  assert.equal(ledger.workflowPayload(workflow.id), null);
  ledger.reserveWorkflow(workflow, payload, p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("used", "used", "request", workflow);
  ledger.finish("used", "used", true);
  assert.equal(open().releaseUnusedWorkflow(workflow), false);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(1116));
});

test("un devis non couvert jusqu’à clôture ne consomme aucune réservation partielle", () => {
  const { ledger, policy: p } = workflowFixture();
  assert.throws(() => ledger.reserveWorkflow(workflow, "signed", p.validUntil + 1, BigInt(p.gas.totalWei)), /trop courte/);
  assert.throws(() => ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.maxTransactionWei)), /Liquidités/);
  assert.equal(ledger.workflowPayload(workflow.id), null);
  assert.deepEqual(ledger.snapshot(), { allocatedUsd: BigInt(0), allocatedWei: BigInt(0), failures: 0 });
  const tight = fixture();
  assert.throws(() => tight.ledger.reserveWorkflow(workflow, "signed", tight.policy.validUntil, BigInt(tight.policy.gas.totalWei)), /insuffisant/);
  assert.equal(tight.ledger.snapshot().allocatedUsd, BigInt(0));
});

test("le coupe-circuit refuse les nouveaux devis et préserve les budgets déjà affectés", async () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("bad", "bad", "request");
  ledger.finish("bad", "bad", false);
  assert.throws(() => open().reserveWorkflow({ id: "new", fingerprint: "new" }, "new", p.validUntil, BigInt(p.gas.totalWei)), /Coupe-circuit/);
  for (let i = 0; i < 16; i++) {
    ledger.reserve(`request-${i}`, "scope", "request", workflow);
    ledger.finish(`request-${i}`, "scope", true);
  }
  assert.throws(() => ledger.reserve("request-17", "scope", "request", workflow), /épuisé/);
  assert.equal(await sendBudgetedTransaction(open(), "close", "close", io(), workflow), txHash);
});

test("une réservation ne peut pas être détournée vers un autre devis ou prolongée", () => {
  const { ledger, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  ledger.reserve("job", "input", "training", workflow);
  ledger.finish("job", "input", true, "{}");
  assert.throws(() => ledger.reserve("job", "input", "training", { ...workflow, fingerprint: "changed" }), /scope/);
  assert.throws(() => ledger.reserve("job", "input", "training"), /scope/);
  assert.throws(() => ledger.reserveWorkflow(workflow, "changed", p.validUntil, BigInt(p.gas.totalWei)), /scope/);
  const originalNow = Date.now;
  try {
    Date.now = () => p.validUntil + 1;
    assert.throws(() => ledger.reserve("late", "late", "request", workflow), /expiré/);
  } finally { Date.now = originalNow; }
});

test("la mesure et le premier reçu d’échec survivent à une reprise sans changer la signature", () => {
  const { ledger, open, policy: p } = workflowFixture();
  ledger.reserveWorkflow(workflow, "signed", p.validUntil, BigInt(p.gas.totalWei));
  assert.equal(ledger.executionEvidence(workflow), null);
  ledger.recordExecutionEvidence(workflow, "measured");
  assert.equal(open().executionEvidence(workflow), "measured");
  assert.throws(() => ledger.recordExecutionEvidence(workflow, "inflated"), /déjà fixée/);
  assert.equal(ledger.fixFailureReceipt(workflow, "first"), "first");
  assert.equal(open().fixFailureReceipt(workflow, "new-timestamp"), "first");
});

test("deux processus ne peuvent promettre la même dernière réserve de clôture", async () => {
  const { path, ledger, policy: p } = fixture((p) => { p.earnedMarginUsdMicros = p.cashUsdMicros = "1216"; });
  const script = `import { BudgetLedger } from ${JSON.stringify(resolve("src/lib/runner/budget-ledger.ts"))};
    const ledger = new BudgetLedger(process.argv[1], 46630, ${JSON.stringify(wallet)});
    try { ledger.reserveWorkflow({id:process.argv[2],fingerprint:process.argv[2]},process.argv[2],${p.validUntil},BigInt(${JSON.stringify(p.gas.totalWei)})); process.stdout.write('admitted'); }
    catch { process.stdout.write('blocked'); } finally { ledger.close(); }`;
  const run = promisify(execFile);
  const results = await Promise.all(["first", "second"].map((id) => run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, path, id])));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ["admitted", "blocked"]);
  assert.equal(ledger.snapshot().allocatedUsd, BigInt(1116));
});
