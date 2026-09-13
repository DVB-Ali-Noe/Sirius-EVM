import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/lib/app-error";
import { preflightErrorMessage } from "./preflight-diagnostics";

test("le préflight distingue SQL, connexion, TLS et RPC sans afficher les secrets", () => {
  const secret = "SECRET_SYNTHETIQUE";
  const sql = Object.assign(new Error(`postgresql://user:${secret}@db.invalid/db`), {
    code: "P2010",
    meta: { code: "42P01", message: secret },
  });
  assert.match(preflightErrorMessage(sql), /P2010.*42P01 : table PostgreSQL absente/);
  const adapter = { meta: { driverAdapterError: { cause: { kind: "TlsConnectionError", reason: secret } } } };
  assert.match(preflightErrorMessage(adapter), /TlsConnectionError : connexion TLS PostgreSQL refusée/);
  const aggregate = new AggregateError([Object.assign(new Error(secret), { code: "ENETUNREACH" })], secret);
  assert.match(preflightErrorMessage(aggregate), /ENETUNREACH : réseau inaccessible/);
  const rpc = Object.assign(new Error(`https://rpc.invalid/${secret}`), { name: "HttpRequestError" });
  assert.match(preflightErrorMessage(rpc), /HttpRequestError : requête HTTP RPC échouée/);
  for (const error of [sql, adapter, aggregate, rpc]) {
    assert.ok(!preflightErrorMessage(error).includes(secret));
  }
});

test("le préflight ignore les codes inconnus et les cycles, et conserve les refus métier", () => {
  const error: Record<string, unknown> = { code: "SECRET_SYNTHETIQUE", kind: "constructor", name: "toString" };
  error.cause = error;
  assert.equal(preflightErrorMessage(error), "Préflight EVM impossible à la dernière étape annoncée — erreur technique non classée");
  assert.equal(preflightErrorMessage(new AppError("Migration bloquée : escrow encore actif", 409)), "Migration bloquée : escrow encore actif");
});
