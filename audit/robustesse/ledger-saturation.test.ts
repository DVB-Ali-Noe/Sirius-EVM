/**
 * Saturation du registre de budget (src/lib/runner/budget.ts:73-110, budget-ledger.ts:397-432).
 *
 *   TEE_MODE=stub NODE_OPTIONS="--conditions=react-server" node --import tsx --test audit/robustesse/ledger-saturation.test.ts
 *
 * Question : quand `policy.maxActive` réservations sont déjà ouvertes (requêtes en cours), une
 * requête légitime qui ouvre un job imbriqué (scellement, entraînement) reçoit-elle un refus
 * compté par le coupe-circuit (`failures`) ? Trois refus comptés ferment le runner à tous.
 *
 * Linux uniquement : le registre exige des droits POSIX 0600 que Windows ne fournit pas.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetLedger, initializeBudgetLedger, type BudgetPolicy } from "@/lib/runner/budget-ledger";
import { runBudgetedOperation } from "@/lib/runner/budget";

const wallet = `0x${"12".repeat(20)}`;

function policy(maxActive: number): BudgetPolicy {
  return {
    version: 1, chainId: 46630, wallet, accountingReference: "audit-synthetic-not-revenue", validUntil: Date.now() + 60_000,
    earnedMarginUsdMicros: "1000000", cashUsdMicros: "1000000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "200000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive,
  };
}

test("ROB-09 — maxActive requêtes en vol : le job imbriqué d'une requête légitime est compté comme panne", { skip: process.platform === "win32" ? "registre POSIX 0600 requis (Linux)" : false }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "sirius-audit-ledger-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "ledger.sqlite");
  const maxActive = 8;
  initializeBudgetLedger(path, policy(maxActive));
  const ledger = new BudgetLedger(path, 46630, wallet);
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // 7 requêtes en vol (le serveur en admet 8 : RUNNER_MAX_CONCURRENT_REQUESTS).
    const inflight = Array.from({ length: maxActive - 1 }, (_, i) =>
      runBudgetedOperation(ledger, "request", `request:busy-${i}`, "request-v1", () => gate));
    await new Promise((resolve) => setImmediate(resolve));
    // 8e requête : un scellement légitime ; sa réservation « request » passe (7 < 8), le job imbriqué non (8 >= 8).
    const legit = runBudgetedOperation(ledger, "request", "request:legit", "request-v1", () =>
      runBudgetedOperation(ledger, "seal", "seal:legit", "fingerprint", async () => "scellé"));
    const outcome = await legit.then(() => "succès", (error: Error) => error.message);
    release();
    await Promise.all(inflight);
    const failures = ledger.snapshot().failures;
    console.log(`[ROB-09] issue de la requête légitime : « ${outcome} » ; pannes comptées : ${failures}/${3}`);
    assert.match(outcome, /Réservations runner en attente de réconciliation/);
    assert.equal(failures, 1, "le refus de capacité est compté par le coupe-circuit");
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
