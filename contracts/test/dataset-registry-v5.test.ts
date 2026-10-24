/**
 * Registre de datasets v5 : liaison de l'escrow, admin, profils (audit reproductibilité, partie B,
 * constats REP-11 à REP-13), puis les garde-fous hors chaîne de `scripts/dataset-binding.ts`.
 *
 * La première partie fige ce que le contrat fait aujourd'hui, sans le changer : une liaison unique
 * et sans contrôle de cohérence, un admin sans transfert, un profil ajouté pour toujours. La
 * seconde vérifie que les contrôles du script refusent ce que le contrat accepterait à tort.
 * Chaîne Hardhat locale, comptes jetables uniquement.
 */
import assert from "node:assert/strict";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { decodeFunctionData, getAddress, getContract, keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { cidHash, datasetIdHash } from "../../src/lib/evm/dataset-key";
import { siriusdatasetregistryAbi } from "../../src/lib/evm/abi/siriusdatasetregistry";
import { siriuskybregistryAbi } from "../../src/lib/evm/abi/siriuskybregistry";
import { selectionForModelId, trainingProfileHash } from "../../src/lib/models/registry";
import {
  addTrainingProfileCall, assertBound, assertCanBind, bindEscrowCall, ESCROW_VERSIONS, profileHashes, readBinding,
  registryAdminAbi, safeTransactionBatch, type BindingReader,
} from "../scripts/dataset-binding";

const YEAR = 365 * 24 * 60 * 60;
const CID_HASH = cidHash("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
const MERKLE_ROOT = keccak256(toHex("merkle-root-audit"));
const LINEAR = keccak256(toHex("sirius.training-profile.v1:linear_regression:1.0.0"));
// Faute de frappe volontaire (« tress ») : l'application ne calculera jamais ce hash.
const TYPO_PROFILE = keccak256(toHex("sirius.training-profile.v1:gradient_boosted_tress:1.0.0"));
const V7 = ESCROW_VERSIONS.SiriusEscrowV7;

async function fixture() {
  const [admin, verifier, provider, other] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const client = { public: publicClient, wallet: admin };
  const kybDeployment = await hre.viem.deployContract("SiriusKybRegistry", [admin.account.address, verifier.account.address]);
  const registryDeployment = await hre.viem.deployContract("SiriusDatasetRegistry", [kybDeployment.address, admin.account.address]);
  const token = await hre.viem.deployContract("MockEscrowToken", [6]);
  const kyb = getContract({ address: kybDeployment.address, abi: siriuskybregistryAbi, client });
  const registry = getContract({ address: registryDeployment.address, abi: siriusdatasetregistryAbi, client });
  const deployEscrow = async (datasets: Address = registry.address) =>
    (await hre.viem.deployContract("SiriusEscrowV7", [token.address, kyb.address, datasets, admin.account.address])).address as Address;
  const reader = publicClient as unknown as BindingReader;
  return { kyb, registry, token, admin, verifier, provider, other, publicClient, reader, deployEscrow };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

async function grantKyb(ctx: Ctx): Promise<void> {
  const subject = ctx.provider.account.address as Address;
  const verifier = ctx.verifier.account.address as Address;
  const expiresAt = (await time.latest()) + YEAR;
  const chainId = await ctx.publicClient.getChainId();
  const signature = (await ctx.verifier.signTypedData({
    domain: { name: "SiriusKybRegistry", version: "2", chainId, verifyingContract: ctx.kyb.address },
    types: {
      KybAttestation: [
        { name: "subject", type: "address" },
        { name: "verifier", type: "address" },
        { name: "expiresAt", type: "uint40" },
        { name: "nonce", type: "uint256" },
        { name: "verifierEpoch", type: "uint64" },
      ],
    },
    primaryType: "KybAttestation",
    message: {
      subject, verifier, expiresAt,
      nonce: await ctx.kyb.read.nonces([subject]),
      verifierEpoch: await ctx.kyb.read.verifierEpoch([verifier]),
    },
  })) as Hex;
  await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], { account: ctx.provider.account });
}

async function mint(ctx: Ctx, id: string, profile: Hex = LINEAR): Promise<Hex> {
  await ctx.registry.write.mint([datasetIdHash(id), CID_HASH, MERKLE_ROOT, 1_000n, profile], { account: ctx.provider.account });
  return ctx.registry.read.datasetIdOf([ctx.provider.account.address, datasetIdHash(id)]);
}

const lower = (value: string) => value.toLowerCase();

describe("SiriusDatasetRegistry v5 : comportement figé (audit REP-11 à REP-13)", () => {
  describe("bindEscrow", () => {
    it("REP-B1 : réservé à l'admin, refuse une adresse sans code, une seule fois", async () => {
      const ctx = await loadFixture(fixture);
      const escrow = await ctx.deployEscrow();
      await assert.rejects(ctx.registry.write.bindEscrow([escrow], { account: ctx.other.account }), /NotAdmin/);
      await assert.rejects(ctx.registry.write.bindEscrow([ctx.other.account.address], { account: ctx.admin.account }), /ZeroAddress/);
      await ctx.registry.write.bindEscrow([escrow], { account: ctx.admin.account });
      await assert.rejects(ctx.registry.write.bindEscrow([escrow], { account: ctx.admin.account }), /EscrowAlreadyBound/);
      const bound = await ctx.registry.getEvents.EscrowBound({}, { fromBlock: 0n });
      assert.equal(bound.length, 1);
    });

    it("REP-B2 : accepte n'importe quel contrat ; un mauvais escrow lié bloque destroy() pour toujours", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx);
      const id = await mint(ctx, "ds-wrong-escrow");
      // Erreur d'opérateur simulée : le registre KYB (qui a du code) est lié à la place de l'escrow.
      await ctx.registry.write.bindEscrow([ctx.kyb.address], { account: ctx.admin.account });
      assert.equal(lower(await ctx.registry.read.escrow()), lower(ctx.kyb.address));
      // destroy() appelle activeLoansForDataset sur un contrat qui ne l'a pas : revert systématique.
      await assert.rejects(ctx.registry.write.destroy([datasetIdHash("ds-wrong-escrow")], { account: ctx.provider.account }));
      // Aucune correction possible : la liaison est définitive.
      await assert.rejects(ctx.registry.write.bindEscrow([ctx.token.address], { account: ctx.admin.account }), /EscrowAlreadyBound/);
      assert.equal(await ctx.registry.read.isLive([id]), true);
    });

    it("REP-B3 : un second escrow pointant sur ce registre ne peut jamais verrouiller (registre lié à un seul escrow)", async () => {
      const ctx = await loadFixture(fixture);
      const first = await ctx.deployEscrow();
      await ctx.registry.write.bindEscrow([first], { account: ctx.admin.account });
      // Le constructeur d'un escrow suivant accepte ce registre, mais le registre ne connaît que le
      // premier : `lock` du second échoue sur DatasetEscrowMismatch. Une migration d'escrow impose
      // donc un nouveau registre.
      const second = await ctx.deployEscrow();
      const state = await readBinding(ctx.reader, ctx.registry.address, second);
      assert.equal(lower(state.escrowDatasets), lower(ctx.registry.address));
      assert.equal(lower(state.boundEscrow), lower(first));
    });

    it("REP-B4 : avant la liaison, destroy() ne consulte aucun prêt", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx);
      const id = await mint(ctx, "ds-unbound");
      assert.equal(await ctx.registry.read.escrow(), zeroAddress);
      await ctx.registry.write.destroy([datasetIdHash("ds-unbound")], { account: ctx.provider.account });
      assert.equal(await ctx.registry.read.isLive([id]), false);
    });
  });

  describe("admin", () => {
    it("REP-B5 : admin fixé au constructeur, aucune fonction ne le change ni ne le transfère", async () => {
      const ctx = await loadFixture(fixture);
      assert.equal(lower(await ctx.registry.read.admin()), lower(ctx.admin.account.address));
      const { abi } = await hre.artifacts.readArtifact("SiriusDatasetRegistry");
      const names = abi.filter((entry: { type: string }) => entry.type === "function").map((entry: { name?: string }) => entry.name ?? "");
      for (const forbidden of ["transferAdmin", "setAdmin", "acceptAdmin", "renounceAdmin", "transferOwnership", "setEscrow"]) {
        assert.ok(!names.includes(forbidden), forbidden);
      }
      // Pas d'événement d'installation de l'admin : seul le getter `admin()` le dit.
      const events = abi.filter((entry: { type: string }) => entry.type === "event").map((entry: { name?: string }) => entry.name ?? "");
      assert.deepEqual(events.sort(), ["DatasetDestroyed", "DatasetMinted", "EscrowBound", "TrainingProfileAdded"]);
    });

    it("REP-B6 : refuse admin nul et KYB nul au constructeur, mais accepte une clé simple (EOA) comme admin", async () => {
      const ctx = await loadFixture(fixture);
      await assert.rejects(hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, zeroAddress]), /ZeroAddress/);
      await assert.rejects(hre.viem.deployContract("SiriusDatasetRegistry", [zeroAddress, ctx.admin.account.address]), /KybRequired/);
      const eoaAdmin = await hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, ctx.other.account.address]);
      const code = await ctx.publicClient.getBytecode({ address: ctx.other.account.address });
      assert.equal(code ?? "0x", "0x");
      const admin = await ctx.publicClient.readContract({ address: eoaAdmin.address, abi: siriusdatasetregistryAbi, functionName: "admin" });
      assert.equal(lower(admin), lower(ctx.other.account.address));
    });
  });

  describe("profils d'entraînement", () => {
    it("REP-B7 : un profil erroné ajouté par l'admin reste accepté au mint pour toujours", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx);
      await ctx.registry.write.addTrainingProfile([TYPO_PROFILE], { account: ctx.admin.account });
      const id = await mint(ctx, "ds-typo", TYPO_PROFILE);
      assert.equal((await ctx.registry.read.getDataset([id])).trainingProfile, TYPO_PROFILE);
      assert.equal(await ctx.registry.read.isSupportedTrainingProfile([TYPO_PROFILE]), true);
      // Aucun retrait : le seul garde-fou est hors chaîne (MODEL_REGISTRY, runner).
      const { abi } = await hre.artifacts.readArtifact("SiriusDatasetRegistry");
      const writes = abi
        .filter((entry: { type: string; stateMutability?: string }) => entry.type === "function" && entry.stateMutability !== "view" && entry.stateMutability !== "pure")
        .map((entry: { name?: string }) => entry.name ?? "");
      assert.deepEqual(writes.filter((name: string) => /remove|revoke|disable|pause/i.test(name)), []);
    });
  });
});

describe("garde-fous hors chaîne de la liaison (scripts/dataset-binding.ts)", () => {
  it("REP-12 : accepte une paire cohérente, puis le lot signé par l'admin lie et ajoute le profil", async () => {
    const ctx = await loadFixture(fixture);
    const escrow = await ctx.deployEscrow();
    const admin = ctx.admin.account.address as Address;
    assertCanBind(await readBinding(ctx.reader, ctx.registry.address, escrow), { admin, escrowVersion: V7 });

    const [trees] = profileHashes(["gradient_boosted_trees"]);
    assert.equal(trees.hash, trainingProfileHash(selectionForModelId("gradient_boosted_trees")));
    const calls = [bindEscrowCall(ctx.registry.address, escrow), addTrainingProfileCall(ctx.registry.address, trees)];
    // Le calldata dit exactement ce que la description annonce au signataire.
    assert.deepEqual(decodeFunctionData({ abi: registryAdminAbi, data: calls[0].data }), { functionName: "bindEscrow", args: [getAddress(escrow)] });
    assert.deepEqual(decodeFunctionData({ abi: registryAdminAbi, data: calls[1].data }), { functionName: "addTrainingProfile", args: [trees.hash] });
    const batch = safeTransactionBatch(31337, admin, "test", calls);
    assert.equal(batch.chainId, "31337");
    assert.deepEqual(batch.transactions.map(({ to, value }) => [to, value]), [[ctx.registry.address, "0"], [ctx.registry.address, "0"]]);

    // Un tiers qui rejoue le lot est refusé : seul l'admin peut le signer.
    await assert.rejects(ctx.other.sendTransaction({ to: calls[0].to, data: calls[0].data }), /NotAdmin/);
    for (const call of calls) await ctx.admin.sendTransaction({ to: call.to, data: call.data });
    assertBound(await readBinding(ctx.reader, ctx.registry.address, escrow), { admin, escrowVersion: V7 });
    assert.equal(await ctx.registry.read.isSupportedTrainingProfile([trees.hash]), true);
  });

  it("REP-12 : refuse un double bind, y compris vers le bon escrow", async () => {
    const ctx = await loadFixture(fixture);
    const escrow = await ctx.deployEscrow();
    const admin = ctx.admin.account.address as Address;
    await ctx.registry.write.bindEscrow([escrow], { account: ctx.admin.account });
    const bound = await readBinding(ctx.reader, ctx.registry.address, escrow);
    assert.throws(() => assertCanBind(bound, { admin }), /déjà lié à l'escrow/);
    assertBound(bound, { admin, escrowVersion: V7 });
    const second = await ctx.deployEscrow();
    const other = await readBinding(ctx.reader, ctx.registry.address, second);
    assert.throws(() => assertCanBind(other, { admin }), /déjà lié, définitivement, à un autre contrat/);
    // Et la vérification après coup refuse le second escrow.
    assert.throws(() => assertBound(other, { admin }), /pas à l'escrow attendu/);
  });

  it("REP-12 : refuse un escrow qui pointe vers un autre registre, ou un contrat qui n'est pas un escrow", async () => {
    const ctx = await loadFixture(fixture);
    const admin = ctx.admin.account.address as Address;
    const otherRegistry = await hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, admin]);
    const foreign = await ctx.deployEscrow(otherRegistry.address);
    const state = await readBinding(ctx.reader, ctx.registry.address, foreign);
    assert.throws(() => assertCanBind(state, { admin }), /pointe vers le registre/);
    // Le cas REP-B2 : le registre KYB, qui a du code, passé pour l'escrow.
    await assert.rejects(readBinding(ctx.reader, ctx.registry.address, ctx.kyb.address), /ne répond pas à .*\(\)/);
    // Une clé simple, sans code.
    await assert.rejects(readBinding(ctx.reader, ctx.registry.address, ctx.other.account.address as Address), /ne contient aucun contrat/);
    // Rien n'a été lié pendant ces refus.
    assert.equal(await ctx.registry.read.escrow(), zeroAddress);
  });

  it("REP-11 : refuse un registre dont l'admin n'est pas celui attendu (Safe), et un escrow d'une autre version", async () => {
    const ctx = await loadFixture(fixture);
    const escrow = await ctx.deployEscrow();
    const state = await readBinding(ctx.reader, ctx.registry.address, escrow);
    assert.throws(() => assertCanBind(state, { admin: ctx.other.account.address as Address }), /pas l'admin attendu/);
    assert.throws(() => assertCanBind(state, { admin: ctx.admin.account.address as Address, escrowVersion: ESCROW_VERSIONS.SiriusEscrow }), /usdc-v6 attendu/);
  });

  it("REP-13 : les empreintes viennent de MODEL_REGISTRY, un identifiant inconnu est refusé", () => {
    assert.throws(() => profileHashes(["gradient_boosted_tress" as never]), /Profil inconnu/);
    assert.notEqual(profileHashes(["gradient_boosted_trees"])[0].hash, TYPO_PROFILE);
  });
});
