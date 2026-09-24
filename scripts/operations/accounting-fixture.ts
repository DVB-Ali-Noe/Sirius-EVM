// Génère un export comptable synthétique avec le vrai registre runner (A1), sans secret ni réseau.
// Usage : node --import tsx scripts/operations/accounting-fixture.ts > scripts/operations/fixtures/runner-accounting-export.v1.json
// Le fichier versionné sert d'exemple et de contrat ; le test le compare à un export frais pour
// détecter tout changement de format côté runner.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BudgetLedger, initializeBudgetLedger, type BudgetPolicy, type RunnerAccountingExport } from "../../src/lib/runner/budget-ledger";

const WALLET = `0x${"12".repeat(20)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

export function syntheticPolicy(): BudgetPolicy {
  return {
    version: 1, chainId: 46630, wallet: WALLET, accountingReference: "fixture-synthetic-not-revenue",
    validUntil: Date.now() + 3_600_000,
    earnedMarginUsdMicros: "100000", cashUsdMicros: "100000", fixedReserveUsdMicros: "100",
    costsUsdMicros: { request: "1", seal: "50", training: "100" },
    gas: { totalWei: "10000000000000", maxTransactionWei: "100000000000", maxGas: "100000", maxFeePerGasWei: "1000000",
      ethUsdMicrosUpperBound: "5000000000", confirmations: 2 },
    maxFailures: 3, maxActive: 16,
  };
}

/**
 * Registre couvrant chaque cas utile à la comptabilité : opération hors devis, succès réglé,
 * échec mesuré avec règlement incertain, calcul incertain et devis jamais démarré.
 */
export function buildSyntheticExport(): RunnerAccountingExport {
  // Le registre date ses opérations avec l'horloge réelle : l'export suit la même horloge.
  const FIXTURE_NOW = Date.now();
  const directory = mkdtempSync(join(tmpdir(), "sirius-accounting-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "ledger.sqlite");
  const policy = syntheticPolicy();
  initializeBudgetLedger(path, policy);
  const ledger = new BudgetLedger(path, policy.chainId, policy.wallet);
  try {
    ledger.reserve("request:standalone", "public-read", "request");
    ledger.finish("request:standalone", "public-read", true);

    const success = { id: "loan:success", fingerprint: "quote-success" };
    ledger.reserveWorkflow(success, "synthetic-signed-quote", policy.validUntil, BigInt(policy.gas.totalWei));
    ledger.prepareWorkflowResult(success, "synthetic-context");
    ledger.reserve("training:success", "input-success", "training", success);
    ledger.recordExecutionEvidence(success, JSON.stringify({ version: 1, quoteHash: success.fingerprint,
      startedAt: FIXTURE_NOW - 60_000, elapsedMs: 1200, success: true }), "synthetic-result");
    ledger.finish("training:success", "input-success", true);
    ledger.reserve("release:success", "data-success", "transaction", success);
    ledger.recordTransaction("release:success", "data-success", hash(1), 7, "synthetic-encrypted-transaction");
    ledger.finish("release:success", "data-success", true);

    const failed = { id: "loan:failure", fingerprint: "quote-failure" };
    ledger.reserveWorkflow(failed, "synthetic-signed-quote", policy.validUntil, BigInt(policy.gas.totalWei));
    ledger.prepareWorkflowResult(failed, "synthetic-context");
    ledger.reserve("training:failure", "input-failure", "training", failed);
    ledger.recordExecutionEvidence(failed, JSON.stringify({ version: 1, quoteHash: failed.fingerprint,
      startedAt: FIXTURE_NOW - 50_000, elapsedMs: 800, success: false }));
    ledger.fixFailureReceipt(failed, JSON.stringify({ consumedCompute: "250000", evidenceHash: hash(2),
      observedAt: Math.floor((FIXTURE_NOW - 49_000) / 1000), finalFailure: true }));
    ledger.reserve("failure:failure", "data-failure", "transaction", failed);
    ledger.recordTransaction("failure:failure", "data-failure", hash(3), 8);

    const uncertain = { id: "loan:uncertain", fingerprint: "quote-uncertain" };
    ledger.reserveWorkflow(uncertain, "synthetic-signed-quote", policy.validUntil, BigInt(policy.gas.totalWei));
    ledger.prepareWorkflowResult(uncertain, "synthetic-context");
    ledger.reserve("training:uncertain", "input-uncertain", "training", uncertain);

    const idle = { id: "loan:not-started", fingerprint: "quote-not-started" };
    ledger.reserveWorkflow(idle, "synthetic-signed-quote", policy.validUntil, BigInt(policy.gas.totalWei));

    return ledger.accountingExport(FIXTURE_NOW);
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(buildSyntheticExport(), null, 2));
}
