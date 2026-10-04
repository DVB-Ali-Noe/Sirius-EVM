import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { DISCLAIMER_IDS } from "../copy/disclaimers";
import { EN_MESSAGES } from "../i18n/english";
import { ERROR_MESSAGES_EN } from "../i18n/errors-en";
import { PHALA_MESSAGES_EN } from "../i18n/phala-en";
import { SHARED_MESSAGES_EN } from "../i18n/shared-en";
import { TOUR_MESSAGES_EN } from "../i18n/tour-en";
import { PAGE_TOURS, TOUR_UI, WELCOME_STEPS, tourTranslationKeys } from "./content";
import { TourController, type TourSnapshot } from "./controller";
import { TOUR_PAGE_KEYS, tourKeyForPath } from "./keys";
import {
  fetchTourProgress,
  parseTourProgress,
  readPending,
  reconcilePending,
  saveTourProgress,
  tourPatchBody,
  toursSuppressedForE2e,
  writePending,
  type FetchLike,
  type StorageLike,
} from "./progress";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;

let profile: typeof import("../users/profile");
before(async () => {
  process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  profile = await import("../users/profile");
});

/** Réponse de `GET /api/profile` telle que la renvoie la route. */
function profileBody(address: string, overrides: Record<string, unknown> = {}) {
  return {
    address,
    tourCompletedAt: null,
    featureTours: {},
    settings: {},
    kybStatus: null,
    kybCheckedAt: null,
    blockedAt: null,
    createdAt: "2026-10-04T10:00:00.000Z",
    lastSeenAt: "2026-10-04T10:00:00.000Z",
    ...overrides,
  };
}

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  failing = false;
  getItem(key: string) {
    if (this.failing) throw new Error("SecurityError");
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failing) throw new Error("QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string) {
    if (this.failing) throw new Error("SecurityError");
    this.map.delete(key);
  }
}

interface Call {
  method: string;
  body: unknown;
}

/**
 * Faux serveur `/api/profile` : garde une progression par wallet « connecté » (`session`),
 * applique les PATCH comme la vraie route et peut échouer à la demande.
 */
class FakeServer {
  session: string | null = A;
  readonly profiles = new Map<string, { tourCompletedAt: string | null; featureTours: Record<string, boolean> }>();
  readonly calls: Call[] = [];
  getMode: "ok" | "500" | "throw" | "empty" | "badJson" = "ok";
  patchMode: "ok" | "500" | "throw" = "ok";
  /** Si posé, le GET attend ce verrou avant de répondre. */
  gate: Promise<void> | null = null;

  row(address: string) {
    if (!this.profiles.has(address)) this.profiles.set(address, { tourCompletedAt: null, featureTours: {} });
    return this.profiles.get(address)!;
  }

  readonly fetch: FetchLike = async (input, init) => {
    assert.equal(input, "/api/profile");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, body });
    const respond = (ok: boolean, json: unknown) => ({ ok, json: async () => json });
    if (method === "GET") {
      const address = this.session;
      if (this.gate) await this.gate;
      if (this.getMode === "throw") throw new TypeError("Failed to fetch");
      if (this.getMode === "500") return respond(false, { error: "Erreur interne" });
      if (this.getMode === "empty") return respond(true, {});
      if (this.getMode === "badJson") return { ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } };
      if (!address) return respond(false, { error: "Authentification requise" });
      return respond(true, profileBody(address, this.row(address)));
    }
    assert.equal(method, "PATCH");
    if (this.patchMode === "throw") throw new TypeError("Failed to fetch");
    if (this.patchMode === "500") return respond(false, { error: "Erreur interne" });
    // Même validation que la vraie route : une forme refusée ferait un 400.
    const patch = profile.validateProfilePatch(body);
    const row = this.row(this.session!);
    if (patch.tourCompletedAt === true) row.tourCompletedAt ??= "2026-10-04T10:00:00.000Z";
    Object.assign(row.featureTours, patch.featureTours ?? {});
    return respond(true, profileBody(this.session!, row));
  };

  count(method: string) {
    return this.calls.filter((call) => call.method === method).length;
  }
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function setup(options: { suppressed?: boolean; server?: FakeServer; storage?: MemoryStorage } = {}) {
  const server = options.server ?? new FakeServer();
  const storage = options.storage ?? new MemoryStorage();
  const controller = new TourController({
    fetch: server.fetch,
    storage: () => storage,
    isSuppressed: () => options.suppressed ?? false,
  });
  controller.start();
  return { server, storage, controller, snap: (): TourSnapshot => controller.getSnapshot() };
}

describe("clés et chemins", () => {
  test("les clés client sont exactement celles acceptées par l'API", () => {
    assert.deepEqual([...TOUR_PAGE_KEYS], [...profile.FEATURE_TOUR_KEYS]);
  });

  test("chaque page principale a sa clé, les autres chemins n'en ont pas", () => {
    assert.equal(tourKeyForPath("/dashboard"), "dashboard");
    assert.equal(tourKeyForPath("/datasets"), "datasets");
    assert.equal(tourKeyForPath("/datasets/new"), "upload");
    assert.equal(tourKeyForPath("/datasets/new/"), "upload");
    assert.equal(tourKeyForPath("/marketplace"), "marketplace");
    assert.equal(tourKeyForPath("/train"), "train");
    assert.equal(tourKeyForPath("/explorer"), "explorer");
    assert.equal(tourKeyForPath("/wallet"), "wallet");
    for (const path of ["/", "/borrow", "/phala", "/provider", "/datasets/abc", "/marketplace/x", "/Dashboard", "dashboard", "/constructor", "/__proto__", "", null, undefined, `/${"a".repeat(300)}`]) {
      assert.equal(tourKeyForPath(path as string), null, String(path));
    }
  });
});

describe("lecture de la progression", () => {
  test("réponse conforme : tuto fait ou non, pages vues", () => {
    assert.deepEqual(parseTourProgress(profileBody(A), A), { welcomeDone: false, pages: {} });
    assert.deepEqual(
      parseTourProgress(profileBody(A, { tourCompletedAt: "2026-10-04T10:00:00.000Z", featureTours: { train: true, wallet: false } }), A),
      { welcomeDone: true, pages: { train: true, wallet: false } },
    );
    // Casse de l'adresse attendue indifférente.
    assert.ok(parseTourProgress(profileBody(A), A.toUpperCase().replace("0X", "0x")));
  });

  test("toute réponse inattendue donne « inconnue » (null), donc aucune ouverture", () => {
    const cases: unknown[] = [
      null, undefined, "x", 42, [], {}, { known: true }, { authenticated: false, known: true },
      profileBody(B), // profil d'un autre wallet resté en session
      { ...profileBody(A), tourCompletedAt: undefined },
      (() => { const body: Record<string, unknown> = profileBody(A); delete body.tourCompletedAt; return body; })(),
      profileBody(A, { tourCompletedAt: "" }),
      profileBody(A, { tourCompletedAt: 1 }),
      profileBody(A, { tourCompletedAt: true }),
      profileBody(A, { featureTours: null }),
      profileBody(A, { featureTours: [] }),
      profileBody(A, { address: "not-an-address" }),
    ];
    for (const body of cases) assert.equal(parseTourProgress(body, A), null, JSON.stringify(body));
    assert.equal(parseTourProgress(profileBody(A), "pas une adresse"), null);
  });

  test("clés inconnues et valeurs non booléennes de featureTours ignorées", () => {
    // JSON.parse crée une vraie clé « __proto__ », comme le ferait une ligne altérée en base.
    const featureTours = JSON.parse('{"train":"yes","admin":true,"__proto__":{"dashboard":true},"wallet":true}');
    const parsed = parseTourProgress(profileBody(A, { featureTours }), A);
    assert.deepEqual(parsed, { welcomeDone: false, pages: { wallet: true } });
  });

  test("échecs réseau, HTTP et JSON : null, sans exception", async () => {
    const make = (impl: FetchLike) => fetchTourProgress(impl, A);
    assert.equal(await make(async () => { throw new TypeError("offline"); }), null);
    assert.equal(await make(async () => ({ ok: false, json: async () => profileBody(A) })), null);
    assert.equal(await make(async () => ({ ok: true, json: async () => { throw new SyntaxError("x"); } })), null);
    assert.deepEqual(await make(async () => ({ ok: true, json: async () => profileBody(A) })), { welcomeDone: false, pages: {} });
  });
});

describe("écriture de la progression", () => {
  test("corps du PATCH : uniquement des true, refusé vide, accepté par la validation serveur", () => {
    assert.equal(tourPatchBody({}), null);
    assert.equal(tourPatchBody({ featureTours: {} }), null);
    const welcome = tourPatchBody({ tourCompletedAt: true })!;
    const page = tourPatchBody({ featureTours: { train: true, wallet: true } })!;
    const both = tourPatchBody({ tourCompletedAt: true, featureTours: { upload: true } })!;
    assert.deepEqual(JSON.parse(welcome), { tourCompletedAt: true });
    assert.deepEqual(JSON.parse(page), { featureTours: { train: true, wallet: true } });
    for (const body of [welcome, page, both]) assert.doesNotThrow(() => profile.validateProfilePatch(JSON.parse(body)));
    // Une clé inconnue glissée par erreur n'atteint jamais le serveur.
    assert.deepEqual(JSON.parse(tourPatchBody({ featureTours: { admin: true } as never, tourCompletedAt: true })!), { tourCompletedAt: true });
  });

  test("PATCH : true seulement sur une réponse 2xx", async () => {
    const calls: RequestInit[] = [];
    const ok: FetchLike = async (_input, init) => { calls.push(init!); return { ok: true, json: async () => ({}) }; };
    assert.equal(await saveTourProgress(ok, { tourCompletedAt: true }), true);
    assert.equal(calls[0].method, "PATCH");
    assert.equal((calls[0].headers as Record<string, string>)["content-type"], "application/json");
    assert.equal(await saveTourProgress(async () => ({ ok: false, json: async () => ({}) }), { tourCompletedAt: true }), false);
    assert.equal(await saveTourProgress(async () => { throw new TypeError("offline"); }, { tourCompletedAt: true }), false);
    // Rien à écrire : aucun appel.
    assert.equal(await saveTourProgress(async () => { throw new Error("ne doit pas être appelé"); }, {}), true);
  });
});

describe("note locale de repli", () => {
  test("aller-retour, filtrage, suppression quand elle est vide", () => {
    const storage = new MemoryStorage();
    writePending(storage, A, { welcome: true, pages: ["train", "train", "nope" as never] });
    assert.deepEqual(readPending(storage, A.toUpperCase().replace("0X", "0x")), { welcome: true, pages: ["train"] });
    assert.deepEqual(readPending(storage, B), { welcome: false, pages: [] }, "une note par wallet");
    writePending(storage, A, { welcome: false, pages: [] });
    assert.equal(storage.map.size, 0);
  });

  test("note illisible, trop longue ou stockage interdit : vide, sans exception", () => {
    const storage = new MemoryStorage();
    const key = `sirius-tour-pending:${A}`;
    for (const raw of ["{", "null", "[]", '"x"', JSON.stringify({ welcome: "yes", pages: "train" }), JSON.stringify({ welcome: true, pages: ["x".repeat(2000)] })]) {
      storage.map.set(key, raw);
      const pending = readPending(storage, A);
      assert.equal(pending.pages.length, 0, raw);
      assert.equal(pending.welcome, false, raw);
    }
    storage.failing = true;
    assert.deepEqual(readPending(storage, A), { welcome: false, pages: [] });
    assert.doesNotThrow(() => writePending(storage, A, { welcome: true, pages: [] }));
    assert.deepEqual(readPending(null, A), { welcome: false, pages: [] });
    assert.doesNotThrow(() => writePending(null, A, { welcome: true, pages: [] }));
  });

  test("réconciliation : seul ce que la base ignore est renvoyé", () => {
    const pending = { welcome: true, pages: ["train", "wallet"] as const };
    const { patch, remaining } = reconcilePending({ welcomeDone: true, pages: { train: true } }, { welcome: pending.welcome, pages: [...pending.pages] });
    assert.deepEqual(patch, { featureTours: { wallet: true } });
    assert.deepEqual(remaining, { welcome: false, pages: ["wallet"] });
    assert.deepEqual(reconcilePending({ welcomeDone: false, pages: {} }, { welcome: false, pages: [] }).patch, {});
  });

  test("neutralisation e2e : build de test ET marqueur posé, jamais autrement", () => {
    const storage = new MemoryStorage();
    assert.equal(toursSuppressedForE2e("1", storage), false, "build e2e sans marqueur");
    storage.setItem("sirius-tour-seen", "1");
    assert.equal(toursSuppressedForE2e(undefined, storage), false, "production : le marqueur ne neutralise rien");
    assert.equal(toursSuppressedForE2e("0", storage), false);
    assert.equal(toursSuppressedForE2e("true", storage), false);
    assert.equal(toursSuppressedForE2e("1", storage), true);
    assert.equal(toursSuppressedForE2e("1", null), false);
    storage.failing = true;
    assert.equal(toursSuppressedForE2e("1", storage), false);
  });
});

describe("contrôleur : quand ouvrir", () => {
  test("sans session signée : aucun appel, rien ne s'ouvre, le bouton « ? » reste disponible", async () => {
    const { server, controller, snap } = setup();
    controller.setIdentity(A, false);
    controller.setPath("/dashboard");
    await flush();
    assert.equal(server.calls.length, 0);
    assert.equal(snap().active, null);
    assert.equal(snap().status, "idle");
    assert.equal(snap().pageKey, "dashboard");
    controller.setIdentity(null, true);
    await flush();
    assert.equal(server.calls.length, 0);
  });

  test("première connexion : le tuto d'accueil s'ouvre seul, une seule fois, puis le tuto de page à la page suivante", async () => {
    const { server, controller, snap } = setup();
    controller.setPath("/dashboard");
    controller.setIdentity(A, true);
    assert.equal(snap().status, "loading");
    await flush();
    assert.equal(server.count("GET"), 1);
    assert.equal(snap().active?.kind, "welcome");
    assert.equal(snap().active?.manual, false);

    controller.close();
    await flush();
    assert.equal(snap().active, null);
    assert.deepEqual(server.calls.at(-1), { method: "PATCH", body: { tourCompletedAt: true } });
    assert.notEqual(server.row(A).tourCompletedAt, null);

    // Le tuto du tableau de bord ne s'enchaîne pas sur la même page…
    controller.setPath("/dashboard");
    assert.equal(snap().active, null);
    // …mais celui de la page suivante s'ouvre.
    controller.setPath("/marketplace");
    assert.deepEqual(snap().active, { kind: "page", key: "marketplace", manual: false, id: snap().active!.id });
    controller.close();
    await flush();
    assert.deepEqual(server.calls.at(-1), { method: "PATCH", body: { featureTours: { marketplace: true } } });

    // Revenir sur une page déjà vue ne rouvre rien ; le tableau de bord, différé, s'ouvre.
    controller.setPath("/marketplace");
    assert.equal(snap().active, null);
    controller.setPath("/wallet");
    controller.close();
    controller.setPath("/dashboard");
    assert.equal(snap().active?.kind, "page");
    controller.close();
    await flush();
    assert.deepEqual(server.row(A).featureTours, { marketplace: true, wallet: true, dashboard: true });
  });

  test("rechargement : la progression vient du serveur, rien ne se rouvre", async () => {
    const server = new FakeServer();
    server.row(A).tourCompletedAt = "2026-10-01T00:00:00.000Z";
    server.row(A).featureTours = { train: true };
    const { controller, snap } = setup({ server });
    controller.setIdentity(A, true);
    controller.setPath("/train");
    await flush();
    assert.equal(snap().status, "ready");
    assert.equal(snap().active, null);
    controller.setPath("/explorer");
    assert.equal(snap().active?.kind, "page");
  });

  test("autre appareil : la progression suit le wallet, pas le navigateur", async () => {
    const server = new FakeServer();
    const first = setup({ server });
    first.controller.setIdentity(A, true);
    first.controller.setPath("/upload-inexistant");
    await flush();
    first.controller.close();
    await flush();
    // Nouveau navigateur, stockage vide : le serveur dit « fait ».
    const second = setup({ server, storage: new MemoryStorage() });
    second.controller.setIdentity(A, true);
    second.controller.setPath("/wallet");
    await flush();
    assert.equal(second.snap().active?.kind, "page", "accueil déjà fait : seul le tuto de page s'ouvre");
  });

  test("un tuto de page fermé ne se rouvre pas, même en repassant plusieurs fois", async () => {
    const server = new FakeServer();
    server.row(A).tourCompletedAt = "2026-10-01T00:00:00.000Z";
    const { controller, snap } = setup({ server });
    controller.setIdentity(A, true);
    controller.setPath("/train");
    await flush();
    assert.equal(snap().active?.kind, "page");
    controller.close();
    for (const path of ["/train", "/", "/train", "/train/"]) {
      controller.setPath(path);
      assert.equal(snap().active, null, path);
    }
    await flush();
    assert.equal(server.count("PATCH"), 1);
  });

  test("navigation pendant un tuto de page : compté comme vu", async () => {
    const server = new FakeServer();
    server.row(A).tourCompletedAt = "2026-10-01T00:00:00.000Z";
    const { controller, snap } = setup({ server });
    controller.setIdentity(A, true);
    controller.setPath("/train");
    await flush();
    controller.setPath("/borrow");
    assert.equal(snap().active, null);
    await flush();
    assert.deepEqual(server.row(A).featureTours, { train: true });
  });

  test("neutralisé pour l'e2e : aucun appel, aucune ouverture automatique", async () => {
    const { server, controller, snap } = setup({ suppressed: true });
    controller.setIdentity(A, true);
    controller.setPath("/dashboard");
    await flush();
    assert.equal(server.calls.length, 0);
    assert.equal(snap().active, null);
    assert.equal(snap().suppressed, true);
  });
});

describe("contrôleur : repli quand l'API échoue", () => {
  for (const mode of ["500", "throw", "empty", "badJson"] as const) {
    test(`lecture en échec (${mode}) : rien ne s'ouvre, l'interface n'est pas bloquée`, async () => {
      const server = new FakeServer();
      server.getMode = mode;
      const { controller, snap } = setup({ server });
      controller.setIdentity(A, true);
      controller.setPath("/dashboard");
      await flush();
      assert.equal(snap().status, "unavailable");
      assert.equal(snap().active, null);
      controller.setPath("/train");
      assert.equal(snap().active, null);
      assert.equal(server.count("GET"), 1, "pas de nouvelle lecture à chaque navigation");
    });
  }

  test("lecture en échec : le bouton « ? » ouvre quand même, et la fermeture tente l'écriture", async () => {
    const server = new FakeServer();
    server.getMode = "500";
    const { controller, snap } = setup({ server });
    controller.setIdentity(A, true);
    controller.setPath("/train");
    await flush();
    controller.openPage("train");
    assert.equal(snap().active?.kind, "page");
    controller.close();
    await flush();
    assert.deepEqual(server.calls.at(-1), { method: "PATCH", body: { featureTours: { train: true } } });
  });

  for (const mode of ["500", "throw"] as const) {
    test(`écriture en échec (${mode}) : pas de réouverture en boucle, renvoi au chargement suivant`, async () => {
      const server = new FakeServer();
      server.patchMode = mode;
      const storage = new MemoryStorage();
      const first = setup({ server, storage });
      first.controller.setIdentity(A, true);
      first.controller.setPath("/dashboard");
      await flush();
      assert.equal(first.snap().active?.kind, "welcome");
      first.controller.close();
      await flush();
      assert.equal(server.row(A).tourCompletedAt, null, "la base n'a rien reçu");
      assert.deepEqual(readPending(storage, A), { welcome: true, pages: [] });

      // Même onglet : rien ne se rouvre.
      first.controller.setPath("/marketplace");
      assert.equal(first.snap().active?.kind, "page");
      first.controller.close();
      await flush();
      assert.deepEqual(readPending(storage, A), { welcome: true, pages: ["marketplace"] });

      // Rechargement avec l'écriture toujours en panne : rien ne se rouvre, un seul renvoi groupé.
      const patchesBefore = server.count("PATCH");
      const second = setup({ server, storage });
      second.controller.setIdentity(A, true);
      second.controller.setPath("/marketplace");
      await flush();
      assert.equal(second.snap().active, null);
      assert.equal(server.count("PATCH"), patchesBefore + 1);
      assert.deepEqual(server.calls.at(-1)?.body, { tourCompletedAt: true, featureTours: { marketplace: true } });

      // L'écriture revient : le renvoi aboutit et la note locale disparaît.
      server.patchMode = "ok";
      const third = setup({ server, storage });
      third.controller.setIdentity(A, true);
      third.controller.setPath("/marketplace");
      await flush();
      assert.equal(third.snap().active, null);
      assert.notEqual(server.row(A).tourCompletedAt, null);
      assert.deepEqual(server.row(A).featureTours, { marketplace: true });
      assert.equal(storage.map.size, 0);
    });
  }

  test("note locale déjà connue de la base : effacée sans écriture", async () => {
    const server = new FakeServer();
    server.row(A).tourCompletedAt = "2026-10-01T00:00:00.000Z";
    const storage = new MemoryStorage();
    writePending(storage, A, { welcome: true, pages: [] });
    const { controller } = setup({ server, storage });
    controller.setIdentity(A, true);
    await flush();
    assert.equal(server.count("PATCH"), 0);
    assert.equal(storage.map.size, 0);
  });

  test("stockage local interdit : tout fonctionne, seule la note de repli manque", async () => {
    const storage = new MemoryStorage();
    storage.failing = true;
    const { server, controller, snap } = setup({ storage });
    controller.setIdentity(A, true);
    controller.setPath("/dashboard");
    await flush();
    assert.equal(snap().active?.kind, "welcome");
    controller.close();
    await flush();
    assert.notEqual(server.row(A).tourCompletedAt, null);
  });
});

describe("contrôleur : changements de wallet et relances", () => {
  test("réponse tardive d'un wallet précédent ignorée", async () => {
    const server = new FakeServer();
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => { release = resolve; });
    server.row(B).tourCompletedAt = "2026-10-01T00:00:00.000Z";
    server.row(B).featureTours = Object.fromEntries(TOUR_PAGE_KEYS.map((key) => [key, true]));
    const { controller, snap } = setup({ server });
    controller.setPath("/dashboard");
    controller.setIdentity(A, true); // GET de A en attente…
    server.session = B;
    controller.setIdentity(B, true); // …puis bascule vers B
    server.gate = null;
    release();
    await flush();
    assert.equal(snap().active, null, "le profil « neuf » de A ne doit pas ouvrir de tuto pour B");
    assert.equal(snap().status, "ready");
  });

  test("déconnexion : un tuto ouvert automatiquement se ferme sans rien écrire", async () => {
    const { server, controller, snap } = setup();
    controller.setIdentity(A, true);
    controller.setPath("/dashboard");
    await flush();
    assert.equal(snap().active?.kind, "welcome");
    controller.setIdentity(null, false);
    assert.equal(snap().active, null);
    await flush();
    assert.equal(server.count("PATCH"), 0);
  });

  test("relance du tuto d'accueil : s'ouvre même sans session, n'écrit rien sans wallet", async () => {
    const { server, controller, snap } = setup();
    controller.restartWelcome();
    assert.deepEqual(snap().active, { kind: "welcome", manual: true, id: snap().active!.id });
    const firstId = snap().active!.id;
    controller.restartWelcome();
    assert.notEqual(snap().active!.id, firstId, "une relance repart de la première étape");
    controller.close();
    await flush();
    assert.equal(server.calls.length, 0);
  });

  test("relance du tuto d'accueil déjà fait : pas de nouvelle écriture, la date n'est pas déplacée", async () => {
    const server = new FakeServer();
    server.row(A).tourCompletedAt = "2026-10-01T00:00:00.000Z";
    server.row(A).featureTours = { dashboard: true };
    const { controller, snap } = setup({ server });
    controller.setIdentity(A, true);
    controller.setPath("/dashboard");
    await flush();
    controller.restartWelcome();
    assert.equal(snap().active?.kind, "welcome");
    controller.close();
    controller.openPage("dashboard");
    controller.close();
    await flush();
    assert.equal(server.count("PATCH"), 0);
    assert.equal(server.row(A).tourCompletedAt, "2026-10-01T00:00:00.000Z");
  });

  test("un tuto relancé à la main survit à la connexion du wallet", async () => {
    const { controller, snap } = setup();
    controller.setPath("/train");
    controller.openPage("train");
    controller.setIdentity(A, true);
    assert.equal(snap().active?.kind, "page");
    await flush();
    assert.equal(snap().active?.kind, "page", "le tuto d'accueil ne remplace pas celui qu'on lit");
  });

  test("abonnement : chaque changement notifie, le désabonnement est effectif", () => {
    const { controller } = setup();
    let calls = 0;
    const unsubscribe = controller.subscribe(() => { calls += 1; });
    controller.openPage("wallet");
    controller.close();
    assert.equal(calls, 2);
    unsubscribe();
    controller.openPage("wallet");
    assert.equal(calls, 2);
  });
});

describe("textes", () => {
  test("tuto d'accueil : les six étapes du cahier des charges", () => {
    assert.deepEqual(WELCOME_STEPS.map((step) => EN_MESSAGES[step.title]), [
      "Welcome to Sirius", "Borrow a dataset", "Publish a dataset", "Your wallet", "Beta limits", "Need more?",
    ]);
    assert.deepEqual(WELCOME_STEPS[4].disclaimers, ["modelQuality", "betaLimits"]);
    assert.deepEqual(WELCOME_STEPS[5].disclaimers, ["contactUs"]);
  });

  test("chaque page a un tuto ; contact et limites des modèles là où c'est pertinent", () => {
    assert.deepEqual(Object.keys(PAGE_TOURS).sort(), [...TOUR_PAGE_KEYS].sort());
    for (const key of ["upload", "marketplace", "train"] as const) {
      assert.ok(PAGE_TOURS[key].disclaimers?.includes("contactUs"), key);
      assert.ok(PAGE_TOURS[key].disclaimers?.includes("modelQuality"), key);
    }
    assert.ok(PAGE_TOURS.upload.disclaimers?.includes("dataLimits"));
    for (const step of [...WELCOME_STEPS, ...Object.values(PAGE_TOURS)]) {
      for (const id of step.disclaimers ?? []) assert.ok(DISCLAIMER_IDS.includes(id), id);
      assert.ok(step.body.length > 0 || (step.disclaimers?.length ?? 0) > 0, step.title);
    }
  });

  test("chaque clé des tutos a une traduction anglaise", () => {
    const missing = tourTranslationKeys().filter((key) => !Object.hasOwn(EN_MESSAGES, key));
    assert.deepEqual(missing, []);
    assert.equal(EN_MESSAGES[TOUR_UI.helpButton], "Show this page's guide");
  });

  test("aucune clé des tutos n'écrase une traduction existante différente", () => {
    const others = { ...ERROR_MESSAGES_EN, ...PHALA_MESSAGES_EN, ...SHARED_MESSAGES_EN };
    for (const [key, value] of Object.entries(TOUR_MESSAGES_EN)) {
      if (Object.hasOwn(others, key)) assert.equal(others[key], value, key);
      assert.equal(EN_MESSAGES[key], value, `${key} écrasée plus loin dans english.ts`);
    }
  });

  test("aucune promesse de performance, de rendement ou de sécurité absolue", () => {
    const english = tourTranslationKeys().map((key) => EN_MESSAGES[key]).join("\n");
    for (const banned of [/guarantee/i, /\bstate[- ]of[- ]the[- ]art\b/i, /\bbest\b/i, /\baccurate\b/i, /\bprofit/i, /\b100 ?%/, /\bunhackable\b/i, /\bcompletely secure\b/i, /\brisk[- ]free\b/i]) {
      assert.doesNotMatch(english, banned);
    }
  });
});
