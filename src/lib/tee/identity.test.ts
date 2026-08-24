import assert from "node:assert/strict";
import { test } from "node:test";
import { replayRtMr3, verifyEventLogIdentity } from "./identity";
import { isAcceptedTcbStatus } from "./quote";

const composeHash = "12".repeat(32);
const eventLog = JSON.stringify([
  {
    imr: 3,
    event_type: 1,
    digest: "ab".repeat(48),
    event: "compose-hash",
    event_payload: composeHash,
  },
  {
    imr: 2,
    event_type: 1,
    digest: "cd".repeat(48),
    event: "other",
    event_payload: "ignored",
  },
]);

test("rejoue RTMR3 et lie exactement le compose_hash mesuré", () => {
  const rtMr3 = replayRtMr3(eventLog);
  assert.deepEqual(verifyEventLogIdentity(eventLog, rtMr3, composeHash), {
    replayedRtMr3: rtMr3,
    eventLogMatches: true,
    composeEventMatches: true,
  });
});

test("rejette un event-log ou un compose_hash substitué", () => {
  const rtMr3 = replayRtMr3(eventLog);
  assert.equal(verifyEventLogIdentity(eventLog, "00".repeat(48), composeHash).eventLogMatches, false);
  assert.equal(verifyEventLogIdentity(eventLog, rtMr3, "34".repeat(32)).composeEventMatches, false);
});

test("refuse tout statut TCB dégradé", () => {
  assert.equal(isAcceptedTcbStatus("UpToDate"), true);
  assert.equal(isAcceptedTcbStatus("OutOfDate"), false);
  assert.equal(isAcceptedTcbStatus("ConfigurationNeeded"), false);
  assert.equal(isAcceptedTcbStatus("SWHardeningNeeded"), false);
});
