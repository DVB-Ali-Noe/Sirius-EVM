import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_DEMO_URL, liveDemoOpen } from "./live-session";

test("l'annonce n'apparaît que pour une session ouverte et disponible", () => {
  assert.equal(liveDemoOpen({ phase: "open", available: true }), true);
  assert.equal(liveDemoOpen({ phase: "open", available: false }), false);
  assert.equal(liveDemoOpen({ phase: "opening", available: true }), false);
  assert.equal(liveDemoOpen({ phase: "closed", available: false }), false);
  assert.equal(liveDemoOpen({ phase: "error" }), false);
  assert.equal(liveDemoOpen(null), false);
  assert.equal(liveDemoOpen("open"), false);
});

test("le lien mène à l'adresse démo en HTTPS", () => {
  assert.equal(new URL(LIVE_DEMO_URL).protocol, "https:");
  assert.equal(new URL(LIVE_DEMO_URL).hostname, "demo.sirius-data.tech");
});
