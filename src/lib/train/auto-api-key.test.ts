import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { AutoApiKeyExistsError, autoCreateApiKey, newlySettledLoanIds, shouldAutoCreateApiKey, type AutoApiKeyDeps, type ExclusiveLocks } from "./auto-api-key";
import type { ApiKeySummary, ApiKeysOverview } from "./api-keys-client";

type Overview = Pick<ApiKeysOverview, "keys" | "apiAccess">;

const KEY: ApiKeySummary = { keyId: "k1", name: "Clé par défaut", createdAt: "2026-11-08T00:00:00.000Z", revokedAt: null, lastUsedAt: null, calls30d: 0 };

function overview(changes: { keys?: ApiKeySummary[]; paid?: boolean; included?: boolean } = {}): Overview {
  return {
    keys: changes.keys ?? [],
    apiAccess: {
      dailyFee: "1500000", paidUntil: "2026-11-10T00:00:00.000Z", paid: changes.paid ?? true,
      rentalExpiresAt: "2026-11-10T00:00:00.000Z", daysToBuy: 0, price: null, included: changes.included ?? true,
    },
  };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

/** Instance séparée du module, comme dans un autre onglet : sa garde en mémoire est vierge. */
function tab(): typeof import("./auto-api-key") {
  const exports = {};
  const source = ts.transpileModule(readFileSync("src/lib/train/auto-api-key.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { exports, Date, require: () => { throw new Error("aucune dépendance attendue"); } });
  return exports as typeof import("./auto-api-key");
}

/** Verrou exclusif `ifAvailable` comme Web Locks : un second demandeur reçoit `null`. */
function memoryLocks(): ExclusiveLocks {
  const held = new Set<string>();
  return {
    async request(name, _options, callback) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { held.delete(name); }
    },
  };
}

/** Serveur simulé : la clé créée apparaît à la lecture suivante, comme après `POST /api-keys`. */
function server(initial: Overview = overview(), locks: ExclusiveLocks | null = memoryLocks(), storage = memoryStorage()) {
  const state = { overview: initial, created: 0, fail: false };
  const deps: AutoApiKeyDeps = {
    list: async () => state.overview,
    create: async () => {
      await Promise.resolve(); // création asynchrone : les appels concurrents se chevauchent
      if (state.fail) throw new Error("Création de la clé API échouée");
      state.created += 1;
      state.overview = { ...state.overview, keys: [...state.overview.keys, KEY] };
      return { keyId: KEY.keyId, name: KEY.name, createdAt: KEY.createdAt, token: "sk_live_k1.secret" };
    },
    storage,
    locks,
  };
  return { state, deps, storage };
}

test("clé d'office : une seule, pour un prêt couvert par l'API incluse et sans aucune clé", async () => {
  const { state, deps } = server();
  assert.equal((await autoCreateApiKey("loan-1", deps))?.token, "sk_live_k1.secret");
  assert.equal(await autoCreateApiKey("loan-1", deps), null, "remontage : déjà faite");
  assert.equal(state.created, 1);
});

test("clé d'office : jamais quand une clé existe ou a été révoquée, ni sans API incluse couverte", async () => {
  for (const initial of [
    overview({ keys: [KEY] }),
    overview({ keys: [{ ...KEY, revokedAt: "2026-11-08T01:00:00.000Z" }] }),
    overview({ paid: false }),
    overview({ included: false }),
  ]) {
    const { state, deps } = server(initial);
    assert.equal(await autoCreateApiKey("loan-1", deps), null);
    assert.equal(state.created, 0);
    assert.equal(shouldAutoCreateApiKey(initial), false);
  }
});

test("clé d'office : double montage (StrictMode) ne crée qu'une clé", async () => {
  const { state, deps } = server(overview(), null, memoryStorage());
  const results = await Promise.all([autoCreateApiKey("loan-1", deps), autoCreateApiKey("loan-1", deps)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(state.created, 1);
});

test("clé d'office : deux onglets simultanés, sans stockage commun, sérialisés par Web Locks", async () => {
  // Deux instances du module (gardes en mémoire distinctes), aucun marqueur : seul le verrou les sépare.
  const shared = server(overview(), memoryLocks(), memoryStorage());
  const tabDeps = { ...shared.deps, storage: null };
  const results = await Promise.all([tab().autoCreateApiKey("loan-1", tabDeps), tab().autoCreateApiKey("loan-1", tabDeps)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(shared.state.created, 1);

  // Témoin : sans Web Locks, les mêmes onglets créeraient deux clés (le serveur refuse alors la seconde).
  const unlocked = server(overview(), null, memoryStorage());
  const bare = { ...unlocked.deps, storage: null };
  await Promise.all([tab().autoCreateApiKey("loan-1", bare), tab().autoCreateApiKey("loan-1", bare)]);
  assert.equal(unlocked.state.created, 2);
});

test("clé d'office : refus serveur (autre appareil) traité comme « déjà une clé », sans erreur", async () => {
  const { state, deps } = server();
  const refused = { ...deps, create: async () => { throw new AutoApiKeyExistsError(); } };
  assert.equal(await autoCreateApiKey("loan-1", refused), null);
  assert.equal(state.created, 0);
});

test("clé d'office : liste serveur à jour après création, même sans verrou ni stockage", async () => {
  // Sans Web Locks ni stockage : la liste serveur suffit après la création.
  const bare = server(overview(), null, memoryStorage());
  const noStorage = { ...bare.deps, storage: null };
  assert.ok(await autoCreateApiKey("loan-2", noStorage));
  assert.equal(await autoCreateApiKey("loan-2", noStorage), null);
  assert.equal(bare.state.created, 1);
});

test("clé d'office : un échec remonte et ne relance jamais de création automatique", async () => {
  const { state, deps } = server();
  state.fail = true;
  await assert.rejects(autoCreateApiKey("loan-1", deps), /Création de la clé API échouée/);
  state.fail = false;
  assert.equal(await autoCreateApiKey("loan-1", deps), null, "le bouton manuel prend le relais");
  assert.equal(state.created, 0);
});

test("clé d'office : stockage inaccessible, la garde serveur reste", async () => {
  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  const { state, deps } = server(overview(), memoryLocks(), throwing);
  assert.ok(await autoCreateApiKey("loan-1", deps));
  assert.equal(await autoCreateApiKey("loan-1", deps), null);
  assert.equal(state.created, 1);
});

test("règlement suivi par la page : emprunts passés à SETTLED entre deux lectures, sans prolongation ni pack", () => {
  const previous = [
    { id: "a", status: "TRAINING" }, { id: "b", status: "SETTLED" }, { id: "c", status: "SETTLING" },
    { id: "ext", status: "SETTLING", extendsLoanId: "b" }, { id: "pass", status: "ESCROWED", packForLoanId: "b" },
  ];
  const next = [
    { id: "a", status: "SETTLED" }, { id: "b", status: "SETTLED" }, { id: "c", status: "CANCELLED" },
    { id: "ext", status: "SETTLED", extendsLoanId: "b" }, { id: "pass", status: "SETTLED", packForLoanId: "b" },
    { id: "new", status: "SETTLED" },
  ];
  assert.deepEqual(newlySettledLoanIds(previous, next), ["a"]);
  assert.deepEqual(newlySettledLoanIds([], next), [], "première lecture : page ouverte après le règlement");
});
