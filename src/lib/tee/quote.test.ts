import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { replayRtMr3 } from "./identity";
import { evaluateCodeIdentity, isRecordedQuoteHardwareValid } from "./quote";

// Audit A-01, A-02 : RTMR3 change à chaque redémarrage de la CVM Phala. L'identité du code
// repose sur MRTD, le compose hash épinglé et le journal d'événements rejoué vers le RTMR3 de
// la quote ; SIRIUS_EXPECTED_RTMR3 n'est plus lu. #112 : l'OS dstack (RTMR0–2, os-image-hash)
// et l'application (app-id, fournisseur de clés KMS) sont épinglés aussi.

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/dstack-0.5.9-rtmr3.json"), "utf8")) as {
  events: Array<{ imr: number; event_type: number; digest: string; event: string; event_payload: string }>;
  rtMr3: string; composeHash: string;
};
const eventLog = JSON.stringify(fixture.events);
const payload = (name: string) => fixture.events.find((event) => event.event === name)!.event_payload;
const report = { mrTd: "a1".repeat(48), rtMr0: "c0".repeat(48), rtMr1: "c1".repeat(48), rtMr2: "c2".repeat(48), rtMr3: fixture.rtMr3 };
const env = {
  SIRIUS_EXPECTED_MRTD: report.mrTd, SIRIUS_EXPECTED_COMPOSE_HASH: fixture.composeHash,
  SIRIUS_EXPECTED_RTMR0: report.rtMr0, SIRIUS_EXPECTED_RTMR1: report.rtMr1, SIRIUS_EXPECTED_RTMR2: report.rtMr2,
  SIRIUS_EXPECTED_OS_IMAGE_HASH: payload("os-image-hash"), SIRIUS_EXPECTED_APP_ID: payload("app-id"),
};
const evidence = { eventLog, composeHash: fixture.composeHash };

/** Journal modifié puis rejoué : RTMR3 reste cohérent, seule la règle étudiée peut échouer. */
function edited(change: (events: typeof fixture.events) => typeof fixture.events) {
  const log = JSON.stringify(change(structuredClone(fixture.events)).map((event) => ({ ...event, digest: "" })));
  return { td: { ...report, rtMr3: replayRtMr3(log) }, evidence: { eventLog: log, composeHash: fixture.composeHash } };
}

test("un RTMR3 différent de l'ancien pin est accepté quand journal, compose, OS, app et MRTD concordent", () => {
  const identity = evaluateCodeIdentity(report, evidence, { ...env, SIRIUS_EXPECTED_RTMR3: "cb".repeat(48) });
  assert.deepEqual(identity, {
    baseImageMatches: true, eventLogMatches: true, composeHashMatches: true, rtMr3Matches: true,
    platformMatches: true, applicationMatches: true, codeIdentityMatches: true,
    appId: payload("app-id"), osImageHash: payload("os-image-hash"),
  });
});

test("un journal qui ne rejoue pas vers le RTMR3 de la quote est refusé", () => {
  const identity = evaluateCodeIdentity({ ...report, rtMr3: "7388e541".padEnd(96, "0") }, evidence, env);
  assert.equal(identity.rtMr3Matches, false);
  assert.equal(identity.eventLogMatches, false);
  assert.equal(identity.codeIdentityMatches, false);
});

test("un compose hash autre que celui épinglé, ou un MRTD différent, est refusé même avec un journal cohérent", () => {
  const other = JSON.parse(eventLog) as Array<{ event: string; event_payload: string }>;
  const compose = other.find((event) => event.event === "compose-hash");
  assert.ok(compose);
  compose.event_payload = "ab".repeat(32);
  const otherLog = JSON.stringify(other);
  const swapped = evaluateCodeIdentity({ ...report, rtMr3: replayRtMr3(otherLog) }, { eventLog: otherLog, composeHash: "ab".repeat(32) }, env);
  assert.equal(swapped.eventLogMatches, true);
  assert.equal(swapped.composeHashMatches, false);
  assert.equal(swapped.codeIdentityMatches, false);
  const image = evaluateCodeIdentity({ ...report, mrTd: "b2".repeat(48) }, evidence, env);
  assert.equal(image.baseImageMatches, false);
  assert.equal(image.codeIdentityMatches, false);
});

test("#112 : un OS dstack autre (RTMR0–2 ou os-image-hash) est refusé", () => {
  for (const field of ["rtMr0", "rtMr1", "rtMr2"] as const) {
    const identity = evaluateCodeIdentity({ ...report, [field]: "ee".repeat(48) }, evidence, env);
    assert.equal(identity.platformMatches, false, field);
    assert.equal(identity.codeIdentityMatches, false, field);
  }
  const os = edited((events) => events.map((event) => event.event === "os-image-hash" ? { ...event, event_payload: "dd".repeat(32) } : event));
  assert.equal(evaluateCodeIdentity(os.td, os.evidence, env).platformMatches, false);
});

test("#112 : une autre application avec le même compose, ou un fournisseur de clés hors KMS, est refusée", () => {
  const app = edited((events) => events.map((event) => event.event === "app-id" ? { ...event, event_payload: "ab".repeat(20) } : event));
  const otherApp = evaluateCodeIdentity(app.td, app.evidence, env);
  assert.equal(otherApp.composeHashMatches, true);
  assert.equal(otherApp.applicationMatches, false);
  assert.equal(otherApp.codeIdentityMatches, false);
  const local = Buffer.from(JSON.stringify({ name: "local", id: "x" })).toString("hex");
  const key = edited((events) => events.map((event) => event.event === "key-provider" ? { ...event, event_payload: local } : event));
  assert.equal(evaluateCodeIdentity(key.td, key.evidence, env).applicationMatches, false);
});

test("#112 : un événement de plateforme dupliqué, ajouté après system-ready, ou absent ne vaut pas la valeur épinglée", () => {
  const late = edited((events) => [...events, { ...events.find((event) => event.event === "app-id")!, event_payload: "ab".repeat(20) }]);
  assert.equal(evaluateCodeIdentity(late.td, late.evidence, env).applicationMatches, false, "app-id rejoué par l'application");
  const moved = edited((events) => {
    const os = events.find((event) => event.event === "os-image-hash")!;
    return [...events.filter((event) => event !== os), os];
  });
  assert.equal(evaluateCodeIdentity(moved.td, moved.evidence, env).platformMatches, false, "os-image-hash après system-ready");
  const missing = edited((events) => events.filter((event) => event.event !== "os-image-hash"));
  assert.equal(evaluateCodeIdentity(missing.td, missing.evidence, env).platformMatches, false, "os-image-hash absent");
  const unready = edited((events) => events.filter((event) => event.event !== "system-ready"));
  assert.equal(evaluateCodeIdentity(unready.td, unready.evidence, env).codeIdentityMatches, false, "journal sans system-ready");
});

test("sans mesure épinglée ni journal, l'identité reste indéterminée, jamais acceptée", () => {
  assert.equal(evaluateCodeIdentity(report, undefined, {}).codeIdentityMatches, null);
  assert.equal(evaluateCodeIdentity(report, evidence, {}).codeIdentityMatches, null);
  const withoutOs: Record<string, string | undefined> = { ...env, SIRIUS_EXPECTED_RTMR0: undefined };
  assert.equal(evaluateCodeIdentity(report, evidence, withoutOs).codeIdentityMatches, null, "pin OS absent : jamais accepté");
});

test("quote enregistrée : un TCB déclassé depuis l'entraînement reste valable, une révocation ou un échec de signature non", () => {
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: true, tcbStatus: "UpToDate" }), true);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false, tcbStatus: "OutOfDate" }), true);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false, tcbStatus: "SWHardeningNeeded" }), true);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false, tcbStatus: "Revoked" }), false);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: false }), false);
  assert.equal(isRecordedQuoteHardwareValid({ hardwareVerified: null }), false);
});
