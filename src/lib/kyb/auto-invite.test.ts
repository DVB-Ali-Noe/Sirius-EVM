import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AUTO_INVITE_VALIDITY_DAYS, autoInviteEnabled, autoInviteStartupNotice, issueAutoInvitation, readAutoInviteConfig,
  type AutoInviteDependencies, type AutoInviteEnvironment, type AutoInviteIssuances, type AutoInviteRegistry,
} from "./auto-invite";
import { decodeKybInvitation, invitationSigner, kybAttestationTypedData } from "./invitation";

const KEY = generatePrivateKey();
const OTHER_KEY = generatePrivateKey();
const VERIFIER = privateKeyToAccount(KEY).address;
const REGISTRY = "0x8bd1590e2e223605adf3ea83dfa4cd272033c24c";
const SUBJECT = "0x5555555555555555555555555555555555555555";
const NOW = new Date("2026-10-06T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const denied = (status: number, pattern: RegExp) => (error: unknown) =>
  (error as { status?: number }).status === status && pattern.test((error as Error).message);

interface ChainState { version?: string; verifiers?: Address[]; epoch?: bigint; nonce?: bigint; valid?: boolean; expiresAt?: number }

function registry(state: ChainState = {}): AutoInviteRegistry & { reads: string[] } {
  const reads: string[] = [];
  const note = <T>(name: string, value: T) => { reads.push(name); return Promise.resolve(value); };
  return {
    reads,
    version: () => note("version", state.version ?? "sirius-kyb-v3"),
    isVerifier: (verifier) => note("isVerifier", (state.verifiers ?? [VERIFIER]).includes(verifier)),
    verifierEpoch: () => note("verifierEpoch", state.epoch ?? BigInt(1)),
    nonces: () => note("nonces", state.nonce ?? BigInt(0)),
    isKybValid: () => note("isKybValid", state.valid ?? false),
    attestationOf: () => note("attestationOf", { expiresAt: state.expiresAt ?? 0 }),
  };
}

function memoryIssuances() {
  const rows: { id: string; subject: string; code: string; at: Date }[] = [];
  let next = 0;
  const store: AutoInviteIssuances = {
    record: async (subject, code, at) => { const id = String(++next); rows.push({ id, subject, code, at }); return id; },
    latestForSubjectSince: async (subject, since) => {
      const row = [...rows].reverse().find((candidate) => candidate.subject === subject && candidate.at > since);
      return row ? { code: row.code } : null;
    },
    countForSubjectSince: async (subject, since) => rows.filter((row) => row.subject === subject && row.at > since).length,
    countSince: async (since) => rows.filter((row) => row.at > since).length,
    remove: async (id) => { const index = rows.findIndex((row) => row.id === id); if (index >= 0) rows.splice(index, 1); },
  };
  return { store, rows };
}

function deps(overrides: Partial<AutoInviteDependencies> & { env?: AutoInviteEnvironment } = {}): AutoInviteDependencies & { logs: string[] } {
  const logs: string[] = [];
  const { env = { SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }, ...rest } = overrides;
  return {
    config: readAutoInviteConfig(env), registry: registry(), issuances: memoryIssuances().store,
    chainId: 4663, registryAddress: getAddress(REGISTRY), now: NOW, log: (line) => logs.push(line), logs, ...rest,
  };
}

test("drapeau et clé : la fonction n'existe que si les deux sont posés et la clé bien formée", () => {
  assert.equal(autoInviteEnabled({}), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "true" }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "1", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY.slice(0, -1) }), false);
  assert.equal(autoInviteEnabled({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: ` ${KEY} ` }), true);
  const config = readAutoInviteConfig({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: "5" });
  assert.equal(config.enabled, true);
  assert.equal(config.account?.address, VERIFIER);
  assert.equal(config.maxPerHour, 5);
  assert.equal(readAutoInviteConfig({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }).maxPerHour, 30);
  assert.equal(readAutoInviteConfig({ SIRIUS_KYB_AUTO_INVITE: "false", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }).account, null);
});

test("au démarrage : drapeau sans clé valide ou clé partagée refusent de démarrer ; drapeau absent ne casse rien ; la clé n'est jamais écrite", () => {
  assert.equal(autoInviteStartupNotice({}), null);
  assert.equal(autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "false" }), null);
  const ignored = autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE_KEY: KEY }) ?? "";
  assert.match(ignored, /ignorée/);
  const open = autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: "12" }) ?? "";
  assert.match(open, /ouvert/);
  assert.ok(open.includes(VERIFIER));
  assert.ok(open.includes("12 invitations par heure"));
  for (const notice of [ignored, open]) assert.ok(!notice.toLowerCase().includes(KEY.slice(2).toLowerCase()));
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true" }), /exige SIRIUS_KYB_AUTO_INVITE_KEY/);
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: "0x1234" }), /exige SIRIUS_KYB_AUTO_INVITE_KEY/);
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "yes", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }), /true ou false/);
  assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY, SIRIUS_KYB_VERIFIER_KEY: KEY.toUpperCase().replace("0X", "0x") }), /dédiée/);
  for (const max of ["0", "-1", "abc", "1001", "1.5"]) {
    assert.throws(() => autoInviteStartupNotice({ SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: max }), /MAX_PER_HOUR/, max);
  }
});

test("l'invitation signée vise exactement le wallet de la session, 30 jours, nonce et époque de la chaîne, signée par la clé dédiée", async () => {
  const d = deps({ registry: registry({ epoch: BigInt(3), nonce: BigInt(7) }) });
  const result = await issueAutoInvitation(SUBJECT.toLowerCase(), d);
  assert.equal(result.subject, getAddress(SUBJECT));
  assert.equal(result.verifier, VERIFIER);
  assert.equal(result.expiresAt, NOW_SECONDS + AUTO_INVITE_VALIDITY_DAYS * 86_400);
  const invitation = decodeKybInvitation(result.code);
  assert.deepEqual(
    { ...invitation, signature: undefined },
    { v: 1, chainId: 4663, registry: getAddress(REGISTRY), subject: getAddress(SUBJECT), verifier: VERIFIER,
      expiresAt: result.expiresAt, nonce: "7", verifierEpoch: "3", signature: undefined },
  );
  assert.equal(await invitationSigner(invitation), VERIFIER);
  // Les données typées sont celles du registre v3 (domaine « SiriusKybRegistry » / « 2 »).
  const typed = kybAttestationTypedData(invitation);
  assert.equal(typed.domain.verifyingContract, getAddress(REGISTRY));
  assert.equal(typed.message.nonce, BigInt(7));
  // Journal : wallet et expiration, jamais la clé ni le code.
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /émise pour 0x5555/);
  assert.ok(!d.logs[0].includes(KEY.slice(2)) && !d.logs[0].includes(result.code));
  assert.ok(!JSON.stringify(result).includes(KEY.slice(2)));
});

test("fonction fermée : 404 avant toute lecture de la chaîne", async () => {
  for (const env of [{}, { SIRIUS_KYB_AUTO_INVITE: "true" }, { SIRIUS_KYB_AUTO_INVITE: "false", SIRIUS_KYB_AUTO_INVITE_KEY: KEY }]) {
    const chain = registry();
    await assert.rejects(issueAutoInvitation(SUBJECT, deps({ env, registry: chain })), denied(404, /indisponible/));
    assert.deepEqual(chain.reads, []);
  }
});

test("vérificateur retiré du registre ou registre inattendu : refus fermé, sans signature ni trace", async () => {
  const issuances = memoryIssuances();
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ registry: registry({ verifiers: [privateKeyToAccount(OTHER_KEY).address] }), issuances: issuances.store })),
    denied(503, /retiré du registre/),
  );
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ registry: registry({ version: "sirius-kyb-v2" }), issuances: issuances.store })),
    denied(503, /Migration/),
  );
  assert.equal(issuances.rows.length, 0);
});

test("KYB déjà valide : refus 409, sauf dans les 7 derniers jours de l'attestation (renouvellement)", async () => {
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ registry: registry({ valid: true, expiresAt: NOW_SECONDS + 8 * 86_400 }) })),
    denied(409, /déjà valide/),
  );
  const renewed = await issueAutoInvitation(SUBJECT, deps({ registry: registry({ valid: true, expiresAt: NOW_SECONDS + 7 * 86_400, nonce: BigInt(1) }) }));
  assert.equal(decodeKybInvitation(renewed.code).nonce, "1");
});

test("une invitation par wallet et par 24 h : resservie à l'identique tant qu'elle vaut encore, sinon 429 ; libre après la fenêtre", async () => {
  const issuances = memoryIssuances();
  const first = await issueAutoInvitation(SUBJECT, deps({ issuances: issuances.store }));
  const again = deps({ issuances: issuances.store, now: new Date(NOW.getTime() + 3_600_000) });
  const second = await issueAutoInvitation(SUBJECT, again);
  assert.equal(second.code, first.code);
  assert.equal(issuances.rows.length, 1);
  assert.match(again.logs[0], /resservie/);
  // Le nonce a bougé (invitation consommée) : le code stocké ne vaut plus, et le plafond s'applique.
  await assert.rejects(
    issueAutoInvitation(SUBJECT, deps({ issuances: issuances.store, registry: registry({ nonce: BigInt(1), valid: true, expiresAt: NOW_SECONDS + 86_400 }) })),
    denied(429, /par wallet et par 24 heures/),
  );
  // Un autre wallet n'est pas concerné.
  await issueAutoInvitation("0x6666666666666666666666666666666666666666", deps({ issuances: issuances.store }));
  assert.equal(issuances.rows.length, 2);
  // Après 24 h, une nouvelle invitation est signée (nonce changé : l'ancienne ne serait plus reservie).
  const later = await issueAutoInvitation(SUBJECT, deps({ issuances: issuances.store, registry: registry({ nonce: BigInt(1) }), now: new Date(NOW.getTime() + 24 * 3_600_000 + 1) }));
  assert.notEqual(later.code, first.code);
  assert.equal(issuances.rows.length, 3);
});

test("plafond global par heure : au-delà, refus 429 et la trace du refus est retirée", async () => {
  const issuances = memoryIssuances();
  const env = { SIRIUS_KYB_AUTO_INVITE: "true", SIRIUS_KYB_AUTO_INVITE_KEY: KEY, SIRIUS_KYB_AUTO_INVITE_MAX_PER_HOUR: "2" };
  for (const digit of ["1", "2"]) await issueAutoInvitation(`0x${digit.repeat(40)}`, deps({ env, issuances: issuances.store }));
  await assert.rejects(issueAutoInvitation(`0x${"3".repeat(40)}`, deps({ env, issuances: issuances.store })), denied(429, /Trop de demandes/));
  assert.equal(issuances.rows.length, 2);
  // Une heure plus tard, la fenêtre est passée.
  await issueAutoInvitation(`0x${"3".repeat(40)}`, deps({ env, issuances: issuances.store, now: new Date(NOW.getTime() + 3_600_000 + 1) }));
  assert.equal(issuances.rows.length, 3);
});
