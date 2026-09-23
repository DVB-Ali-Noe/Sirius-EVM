import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateScenario } from "./costs.mjs";

const plan = { diskGb: 20, computeUsdMicrosPerHour: "58000", diskUsdMicrosPerGbHour: "139" };
test("les coûts incluent le disque arrêté et n’allouent les frais fixes qu’une fois", () => {
  const result = estimateScenario(plan, { name: "session", runningHours: 2, retentionHours: 720, successfulJobs: 10 });
  assert.equal(result.computeUsdMicros, "116000");
  assert.equal(result.storageUsdMicros, "2001600");
  assert.equal(result.totalPhalaUsdMicros, "2117600");
  assert.equal(result.breakEvenPhalaPerSuccessUsdMicros, "211760");
  assert.equal(result.minimumWith25PercentBufferUsdCents, "27");
});
test("une période sans vente n’a aucun prix capable d’en couvrir les coûts", () => {
  assert.throws(() => estimateScenario(plan, { runningHours: 2, retentionHours: 720, successfulJobs: 0 }));
});
