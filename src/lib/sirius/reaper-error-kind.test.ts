import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "@/lib/app-error";
import { RUNNER_WALLET_BUSY, RunnerFinalityPending } from "@/lib/runner/failure-policy";
import { SETTLEMENT_QUEUED } from "@/lib/loans/settlement-status";
import { reaperErrorKind } from "./reaper-errors";

test("une attente de finalité ou un runner occupé n'est pas une passe échouée", () => {
  assert.equal(reaperErrorKind(new RunnerFinalityPending("0xabc")), "pending");
  assert.equal(reaperErrorKind(new AppError(RUNNER_WALLET_BUSY, 503)), "busy");
  assert.equal(reaperErrorKind(new AppError(SETTLEMENT_QUEUED, 503)), "busy");
});

test("toute autre erreur reste une passe échouée, même avec le même message sur un autre statut", () => {
  assert.equal(reaperErrorKind(new AppError(RUNNER_WALLET_BUSY, 409)), "failed");
  assert.equal(reaperErrorKind(new AppError("Transaction on-chain non confirmée ou réorganisée", 409)), "failed");
  assert.equal(reaperErrorKind(new Error("ECONNRESET")), "failed");
  assert.equal(reaperErrorKind("inattendu"), "failed");
});
