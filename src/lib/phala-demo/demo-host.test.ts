import assert from "node:assert/strict";
import { test } from "node:test";
import { demoOnlyRoute, isDemoOnlyHost } from "./demo-host";

test("seule l'adresse démo est restreinte", () => {
  assert.equal(isDemoOnlyHost("demo.sirius-data.tech"), true);
  assert.equal(isDemoOnlyHost("DEMO.sirius-data.tech:443"), true);
  assert.equal(isDemoOnlyHost("demo.sirius-data.tech."), true);
  assert.equal(isDemoOnlyHost("phala.sirius-data.tech"), false);
  assert.equal(isDemoOnlyHost("sirius-evm-staging.vercel.app"), false);
  assert.equal(isDemoOnlyHost("sirius-data.tech"), false);
  assert.equal(isDemoOnlyHost("demo.sirius-data.tech.evil.com"), false);
  assert.equal(isDemoOnlyHost(null), false);
});

test("sur l'adresse démo, seules la page de training et ses ressources passent", () => {
  assert.equal(demoOnlyRoute("/phala"), "allow");
  assert.equal(demoOnlyRoute("/phala/"), "allow");
  assert.equal(demoOnlyRoute("/_next/static/chunks/app.js"), "allow");
  assert.equal(demoOnlyRoute("/examples/regression/housing-prices-train.csv"), "allow");
  assert.equal(demoOnlyRoute("/favicon.ico"), "allow");
  for (const page of ["/", "/dashboard", "/datasets", "/datasets/new", "/marketplace", "/train", "/wallet", "/settings", "/kyb", "/explorer", "/phala-admin", "/certificate/abc"]) {
    assert.equal(demoOnlyRoute(page), "redirect", page);
  }
});

test("sur l'adresse démo, seules les API de la session répondent", () => {
  for (const api of ["/api/phala-demo/session", "/api/phala-demo/results/x", "/api/auth/challenge", "/api/auth/verify", "/api/train", "/api/datasets", "/api/datasets/x/upload", "/api/models/cid"]) {
    assert.equal(demoOnlyRoute(api), "allow", api);
  }
  for (const api of ["/api/faucet", "/api/onramp", "/api/loans", "/api/marketplace", "/api/profile", "/api/admin/me", "/api/kyb/status", "/api/trainer", "/api/auth-bypass", "/api"]) {
    assert.equal(demoOnlyRoute(api), "block", api);
  }
});
