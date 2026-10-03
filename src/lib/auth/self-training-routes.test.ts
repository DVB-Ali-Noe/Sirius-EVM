import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextResponse } from "next/server";
import * as errors from "../errors";
import * as body from "../http/body";
import * as rate from "../http/rate-limit";
import * as access from "../sirius/self-training-access";
import * as admin from "./admin";
import { EN_MESSAGES } from "../i18n/english";

/**
 * Deux familles de contrôles sur le self training réservé à l'équipe (N5) :
 *  - par inspection de source : chaque route sous /api/train appelle la garde juste après
 *    `requireAuth`, avant tout corps, toute base, tout grant et tout runner ; et aucune autre
 *    route n'appelle le module self-train ;
 *  - par exécution des routes dans un bac à sable (même technique que audit-regressions.test.ts) :
 *    un wallet non admin reçoit 403 « Bientôt disponible » sans qu'aucune dépendance coûteuse
 *    ne soit touchée.
 */

const ROOT = process.cwd();
const ADMIN = `0x${"ab".repeat(20)}`;
const VISITOR = `0x${"cd".repeat(20)}`;
const ENV_KEYS = ["SIRIUS_ADMIN_ADDRESSES", "SIRIUS_PHALA_DEMO", "EVM_NETWORK"] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function sourceFiles(directory: string, keep: (name: string) => boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ["generated", "node_modules"].includes(entry.name) ? [] : sourceFiles(path, keep);
    return keep(entry.name) ? [relative(ROOT, path)] : [];
  });
}

const SELF_TRAINING_ROUTES = sourceFiles(join(ROOT, "src", "app", "api", "train"), (name) => name === "route.ts").sort();

function handlers(source: string): { method: string; body: string }[] {
  const matches = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)];
  return matches.map((match, index) => ({
    method: match[1],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

test("les routes de self training sont bien celles attendues", () => {
  assert.deepEqual(SELF_TRAINING_ROUTES, ["src/app/api/train/[id]/key/route.ts", "src/app/api/train/route.ts"]);
});

test("chaque handler de self training appelle la garde admin juste après requireAuth, avant tout le reste", () => {
  const expensive = ["prisma.", "readJson", "assertAuthenticGrant(", "runSelfTrain(", "selfTrainModelKeyInRunner(",
    "enforceRateLimit(", "await params", "assertCurrentRunner(", "assertOwner("];
  for (const file of SELF_TRAINING_ROUTES) {
    const source = read(file);
    assert.match(source, /from "@\/lib\/sirius\/self-training-access"/, `${file} importe la garde`);
    const exported = handlers(source);
    assert.ok(exported.length > 0, `${file} exporte au moins un handler`);
    for (const { method, body: handler } of exported) {
      const auth = handler.indexOf("requireAuth(");
      const guard = handler.indexOf("assertSelfTrainingAccess(");
      assert.ok(auth >= 0, `${file} ${method} : requireAuth`);
      assert.ok(guard > auth, `${file} ${method} : la garde suit requireAuth`);
      const between = handler.slice(auth, guard);
      assert.doesNotMatch(between, /await /, `${file} ${method} : rien d'asynchrone entre requireAuth et la garde`);
      for (const token of expensive) {
        const index = handler.indexOf(token);
        if (index >= 0) assert.ok(index > guard, `${file} ${method} : ${token} vient après la garde`);
      }
    }
  }
});

test("la liste des jobs et le lancement tolèrent la démo Phala, la livraison de clé non", () => {
  const train = read("src/app/api/train/route.ts");
  const [get, post] = handlers(train);
  assert.equal(get.method, "GET");
  assert.match(get.body, /assertSelfTrainingAccess\(session, true\)/);
  assert.equal(post.method, "POST");
  const guards = [...post.body.matchAll(/assertSelfTrainingAccess\((.*?)\);/g)].map((match) => match[1]);
  assert.deepEqual(guards, ["session, true", "session, isDemoTrainingGrant(authorization)"]);
  assert.ok(post.body.indexOf("assertSelfTrainingAccess(session, true)") < post.body.indexOf("readJson"), "premier refus avant le corps");
  assert.ok(post.body.indexOf("isDemoTrainingGrant(authorization)") < post.body.indexOf("assertAuthenticGrant("), "second refus avant le grant");

  const key = read("src/app/api/train/[id]/key/route.ts");
  const [post2] = handlers(key);
  assert.deepEqual([...post2.body.matchAll(/assertSelfTrainingAccess\((.*?)\);/g)].map((match) => match[1]), ["session"]);
});

test("aucune autre route n'atteint le self training ni la livraison de clé self-train", () => {
  const sources = sourceFiles(join(ROOT, "src"), (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name));
  const selfTrainCallers = sources.filter((file) => /from "@\/lib\/sirius\/self-train"/.test(read(file)));
  assert.deepEqual(selfTrainCallers.sort(), ["src/app/api/train/route.ts"]);
  const keyCallers = sources.filter((file) => !file.startsWith("src/lib/tee/") && /\bselfTrainModelKeyInRunner\b/.test(read(file)));
  assert.deepEqual(keyCallers.sort(), ["src/app/api/train/[id]/key/route.ts"]);
  const guardUsers = sources.filter((file) => /from "@\/lib\/sirius\/self-training-access"/.test(read(file)));
  assert.deepEqual(guardUsers.sort(), SELF_TRAINING_ROUTES, "la garde ne sert qu'aux routes de self training");
});

test("/api/admin/me est authentifiée, sans base, et répond avec la même liste que la garde", () => {
  const source = read("src/app/api/admin/me/route.ts");
  const [get] = handlers(source);
  assert.equal(get.method, "GET");
  assert.ok(get.body.indexOf("requireAuth(") < get.body.indexOf("adminAllowed(session.address)"));
  assert.doesNotMatch(source, /prisma|readJson/);
  assert.match(source, /"cache-control": "no-store"/);
  assert.match(read("src/lib/sirius/self-training-access.ts"), /adminAllowed\(session\.address\)/);
});

test("le message de refus est traduit et ne nomme ni la fonction ni le rôle", () => {
  assert.equal(access.SELF_TRAINING_UNAVAILABLE, "Bientôt disponible");
  assert.equal(EN_MESSAGES[access.SELF_TRAINING_UNAVAILABLE], "Coming soon");
  assert.doesNotMatch(access.SELF_TRAINING_UNAVAILABLE, /self|train|admin|équipe|opérateur|réservé/i);
  const error = access.selfTrainingUnavailable();
  assert.ok(error instanceof errors.AppError);
  assert.equal(error.status, 403);
});

test("l'exemption de démo exige SIRIUS_PHALA_DEMO=true ET le testnet, et un grant de démo bien formé", () => {
  assert.equal(access.phalaDemoInstance({ SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "testnet" }), true);
  for (const env of [
    {}, { SIRIUS_PHALA_DEMO: "true" }, { SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "mainnet" },
    { SIRIUS_PHALA_DEMO: "1", EVM_NETWORK: "testnet" }, { SIRIUS_PHALA_DEMO: "TRUE", EVM_NETWORK: "testnet" },
    { SIRIUS_PHALA_DEMO: "false", EVM_NETWORK: "testnet" }, { EVM_NETWORK: "testnet" },
  ]) assert.equal(access.phalaDemoInstance(env), false, JSON.stringify(env));
  assert.equal(access.isDemoTrainingGrant({ payload: { demoSessionRevision: 0 } }), true);
  assert.equal(access.isDemoTrainingGrant({ payload: { demoSessionRevision: 12 } }), true);
  for (const grant of [undefined, null, "x", {}, { payload: null }, { payload: {} }, { payload: { demoSessionRevision: "12" } },
    { payload: { demoSessionRevision: 1.5 } }, { payload: { demoSessionRevision: Number.MAX_SAFE_INTEGER + 1 } },
    { demoSessionRevision: 1 }]) assert.equal(access.isDemoTrainingGrant(grant), false, JSON.stringify(grant));
});

// ───────── Exécution des routes dans un bac à sable ─────────

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const exports = {};
  const source = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(source, { exports, Buffer, Date, Map, Set, console, process: { env: {} }, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Dépendance inattendue : ${name}`);
    return dependencies[name];
  } });
  return exports as T;
}

async function withEnv<T>(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try { return await run(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

function routes(session: { address: string; source: "external" }) {
  const calls: string[] = [];
  const auth = {
    requireAuth: () => session,
    assertAuthenticGrant: async () => { calls.push("assertAuthenticGrant"); },
    assertOwner: () => { calls.push("assertOwner"); },
  };
  const train = load<typeof import("../../app/api/train/route")>("src/app/api/train/route.ts", {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { trainingJob: { findMany: async () => { calls.push("findMany"); return []; } } } },
    "@/lib/sirius/self-train": { runSelfTrain: async (_dataset: string, _owner: string, jobId: string) => {
      calls.push("runSelfTrain"); return { jobId, modelCid: "cid", runnerReceipt: "receipt", metrics: {} }; } },
    "@/lib/sirius/self-training-access": access,
    "@/lib/auth/require-auth": auth,
    "@/lib/errors": errors,
    "@/lib/http/body": body,
  });
  const key = load<typeof import("../../app/api/train/[id]/key/route")>("src/app/api/train/[id]/key/route.ts", {
    "next/server": { NextResponse },
    "@/lib/db": { prisma: { trainingJob: { findUnique: async () => { calls.push("findUnique"); return null; } } } },
    "@/lib/tee/runner-client": { selfTrainModelKeyInRunner: async () => { calls.push("selfTrainModelKeyInRunner"); return {}; } },
    "@/lib/sirius/self-training-access": access,
    "@/lib/auth/require-auth": auth,
    "@/lib/errors": errors,
    "@/lib/http/body": body,
    "@/lib/http/rate-limit": rate,
    "@/lib/runner/provenance": { assertCurrentRunner: async () => { calls.push("assertCurrentRunner"); } },
  });
  const me = load<typeof import("../../app/api/admin/me/route")>("src/app/api/admin/me/route.ts", {
    "next/server": { NextResponse },
    "@/lib/auth/admin": admin,
    "@/lib/auth/require-auth": auth,
    "@/lib/errors": errors,
  });
  return { train, key, me, calls };
}

const json = (url: string, payload: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
const garbage = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "pas du JSON" });
const TRAIN = "https://test.invalid/api/train";
const KEY = "https://test.invalid/api/train/job-1/key";
const ME = "https://test.invalid/api/admin/me";
const params = { params: Promise.resolve({ id: "job-1" }) };
const grant = (extra: Record<string, unknown> = {}) => ({ payload: { subject: VISITOR, ...extra }, signature: "0x" });
const training = (extra?: Record<string, unknown>) => ({ datasetId: "ds-1", jobId: "job-1", datasetReceipt: "receipt", authorization: grant(extra) });

async function refused(response: Response, calls: string[]) {
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Bientôt disponible" });
  assert.deepEqual(calls, [], "aucune dépendance touchée avant le refus");
}

test("hors démo, un wallet non admin est refusé sur chaque route sans corps lu, ni base, ni grant, ni runner", async () => {
  await withEnv({ SIRIUS_ADMIN_ADDRESSES: ADMIN }, async () => {
    const { train, key, me, calls } = routes({ address: VISITOR, source: "external" });
    await refused(await train.GET(new Request(TRAIN)), calls);
    await refused(await train.POST(garbage(TRAIN)), calls);
    await refused(await train.POST(json(TRAIN, training())), calls);
    await refused(await train.POST(json(TRAIN, training({ demoSessionRevision: 1 }))), calls);
    await refused(await key.POST(garbage(KEY), params), calls);
    await refused(await key.POST(json(KEY, { authorization: grant(), deliveryPublicKey: "k" }), params), calls);
    const who = await me.GET(new Request(ME));
    assert.equal(who.status, 200);
    assert.deepEqual(await who.json(), { admin: false });
    assert.equal(who.headers.get("cache-control"), "no-store");
  });
});

test("un wallet de l'équipe passe la garde, quelle que soit la casse, et le flux continue dans l'ordre", async () => {
  const mixed = `0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb`;
  for (const [configured, address] of [[ADMIN, ADMIN], [mixed, ADMIN], [`${VISITOR},${ADMIN}`, mixed]]) {
    await withEnv({ SIRIUS_ADMIN_ADDRESSES: configured }, async () => {
      const { train, key, me, calls } = routes({ address, source: "external" });
      const list = await train.GET(new Request(TRAIN));
      assert.equal(list.status, 200);
      assert.deepEqual(calls.splice(0), ["findMany"]);

      const created = await train.POST(json(TRAIN, training()));
      assert.equal(created.status, 201, await created.text());
      assert.deepEqual(calls.splice(0), ["assertAuthenticGrant", "runSelfTrain"]);

      const incomplete = await train.POST(json(TRAIN, { datasetId: "ds-1" }));
      assert.equal(incomplete.status, 400);
      assert.deepEqual(calls.splice(0), []);

      const delivery = await key.POST(json(KEY, { authorization: grant(), deliveryPublicKey: "k" }), params);
      assert.equal(delivery.status, 404, "la garde passée, la route refuse le job inconnu comme avant");
      assert.deepEqual(calls.splice(0), ["assertAuthenticGrant", "findUnique"]);

      const who = await me.GET(new Request(ME));
      assert.deepEqual(await who.json(), { admin: true });
    });
  }
});

test("liste vide ou mal formée : même l'adresse attendue est refusée partout", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const configured of [undefined, "", `${ADMIN},oops`, `${ADMIN},`]) {
      await withEnv(configured === undefined ? {} : { SIRIUS_ADMIN_ADDRESSES: configured }, async () => {
        const { train, key, me, calls } = routes({ address: ADMIN, source: "external" });
        await refused(await train.GET(new Request(TRAIN)), calls);
        await refused(await train.POST(json(TRAIN, training())), calls);
        await refused(await key.POST(json(KEY, { authorization: grant(), deliveryPublicKey: "k" }), params), calls);
        assert.deepEqual(await (await me.GET(new Request(ME))).json(), { admin: false });
      });
    }
  } finally { console.warn = warn; }
});

test("instance de démo Phala sur testnet : la part publique de la démo reste ouverte, le reste non", async () => {
  await withEnv({ SIRIUS_ADMIN_ADDRESSES: ADMIN, SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "testnet" }, async () => {
    const { train, key, me, calls } = routes({ address: VISITOR, source: "external" });
    const list = await train.GET(new Request(TRAIN));
    assert.equal(list.status, 200, "la page de démo liste ses propres jobs");
    assert.deepEqual(calls.splice(0), ["findMany"]);

    await refused(await train.POST(json(TRAIN, training())), calls);
    await refused(await train.POST(json(TRAIN, training({ demoSessionRevision: "3" }))), calls);
    await refused(await train.POST(json(TRAIN, training({ demoSessionRevision: 1.5 }))), calls);
    await refused(await train.POST(json(TRAIN, { ...training(), authorization: { demoSessionRevision: 3 } })), calls);

    const demo = await train.POST(json(TRAIN, training({ demoSessionRevision: 3 })));
    assert.equal(demo.status, 201, await demo.text());
    assert.deepEqual(calls.splice(0), ["assertAuthenticGrant", "runSelfTrain"]);

    const malformed = await train.POST(garbage(TRAIN));
    assert.equal(malformed.status, 415, "sur la démo, le corps est lu pour reconnaître un grant de démo");
    assert.deepEqual(calls.splice(0), []);

    await refused(await key.POST(json(KEY, { authorization: grant({ demoSessionRevision: 3 }), deliveryPublicKey: "k" }), params), calls);
    assert.deepEqual(await (await me.GET(new Request(ME))).json(), { admin: false });
  });
});

test("la démo n'exempte jamais hors testnet ni avec un drapeau approximatif", async () => {
  for (const env of [
    { SIRIUS_PHALA_DEMO: "true", EVM_NETWORK: "mainnet" },
    { SIRIUS_PHALA_DEMO: "true" },
    { SIRIUS_PHALA_DEMO: "1", EVM_NETWORK: "testnet" },
    { SIRIUS_PHALA_DEMO: "false", EVM_NETWORK: "testnet" },
    { EVM_NETWORK: "testnet" },
  ]) {
    await withEnv({ SIRIUS_ADMIN_ADDRESSES: ADMIN, ...env }, async () => {
      const { train, key, calls } = routes({ address: VISITOR, source: "external" });
      await refused(await train.GET(new Request(TRAIN)), calls);
      await refused(await train.POST(json(TRAIN, training({ demoSessionRevision: 3 }))), calls);
      await refused(await key.POST(json(KEY, { authorization: grant({ demoSessionRevision: 3 }), deliveryPublicKey: "k" }), params), calls);
    });
  }
});
