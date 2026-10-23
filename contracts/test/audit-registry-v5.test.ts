/**
 * Audit reproductibilité (audit/rapports/reproductibilite.md, partie B) : registre de datasets v5.
 *
 * Ces tests ne changent aucun comportement. Ils figent ce que le contrat fait aujourd'hui sur les
 * points que la suite existante ne couvrait pas : liaison de l'escrow (une seule fois, sans
 * contrôle de cohérence), admin sans transfert, profil ajouté pour toujours. Chaîne Hardhat
 * locale, comptes jetables uniquement.
 */
import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { cidHash, datasetIdHash } from "../../src/lib/evm/dataset-key";

const YEAR = 365 * 24 * 60 * 60;
const CID_HASH = cidHash("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
const MERKLE_ROOT = keccak256(toHex("merkle-root-audit"));
const LINEAR = keccak256(toHex("sirius.training-profile.v1:linear_regression:1.0.0"));
// Faute de frappe volontaire (« tress ») : l'application ne calculera jamais ce hash.
const TYPO_PROFILE = keccak256(toHex("sirius.training-profile.v1:gradient_boosted_tress:1.0.0"));

async function fixture() {
  const [admin, verifier, provider, other] = await hre.viem.getWalletClients();
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [admin.account.address, verifier.account.address]);
  const registry = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, admin.account.address]);
  const token = await hre.viem.deployContract("MockEscrowToken", [6]);
  return { kyb, registry, token, admin, verifier, provider, other };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

async function grantKyb(ctx: Ctx): Promise<void> {
  const subject = ctx.provider.account.address as Address;
  const verifier = ctx.verifier.account.address as Address;
  const expiresAt = (await time.latest()) + YEAR;
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
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

async function mint(ctx: Ctx, id: string, profile: Hex = LINEAR) {
  await ctx.registry.write.mint([datasetIdHash(id), CID_HASH, MERKLE_ROOT, 1_000n, profile], { account: ctx.provider.account });
  return ctx.registry.read.datasetIdOf([ctx.provider.account.address, datasetIdHash(id)]);
}

describe("Audit REP — SiriusDatasetRegistry v5", () => {
  describe("bindEscrow", () => {
    it("REP-B1 : réservé à l'admin, refuse une adresse sans code, une seule fois", async () => {
      const ctx = await loadFixture(fixture);
      const escrow = await hre.viem.deployContract("SiriusEscrowV7", [
        ctx.token.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address,
      ]);
      await expect(ctx.registry.write.bindEscrow([escrow.address], { account: ctx.other.account })).to.be.rejectedWith("NotAdmin");
      await expect(ctx.registry.write.bindEscrow([ctx.other.account.address], { account: ctx.admin.account })).to.be.rejectedWith("ZeroAddress");
      await ctx.registry.write.bindEscrow([escrow.address], { account: ctx.admin.account });
      await expect(ctx.registry.write.bindEscrow([escrow.address], { account: ctx.admin.account })).to.be.rejectedWith("EscrowAlreadyBound");
      const bound = await ctx.registry.getEvents.EscrowBound({}, { fromBlock: 0n });
      expect(bound).to.have.length(1);
    });

    it("REP-B2 : accepte n'importe quel contrat ; un mauvais escrow lié bloque destroy() pour toujours", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx);
      const id = await mint(ctx, "ds-wrong-escrow");
      // Erreur d'opérateur simulée : le registre KYB (qui a du code) est lié à la place de l'escrow.
      await ctx.registry.write.bindEscrow([ctx.kyb.address as Address], { account: ctx.admin.account });
      expect((await ctx.registry.read.escrow()).toLowerCase()).to.equal(ctx.kyb.address.toLowerCase());
      // destroy() appelle activeLoansForDataset sur un contrat qui ne l'a pas : revert systématique.
      await expect(ctx.registry.write.destroy([datasetIdHash("ds-wrong-escrow")], { account: ctx.provider.account })).to.be.rejected;
      // Aucune correction possible : la liaison est définitive.
      await expect(ctx.registry.write.bindEscrow([ctx.token.address], { account: ctx.admin.account })).to.be.rejectedWith("EscrowAlreadyBound");
      expect(await ctx.registry.read.isLive([id])).to.equal(true);
    });

    it("REP-B3 : un second escrow pointant sur ce registre ne peut jamais verrouiller (registre lié à un seul escrow)", async () => {
      const ctx = await loadFixture(fixture);
      const first = await hre.viem.deployContract("SiriusEscrowV7", [
        ctx.token.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address,
      ]);
      await ctx.registry.write.bindEscrow([first.address], { account: ctx.admin.account });
      // Le constructeur d'un escrow suivant accepte ce registre…
      const second = await hre.viem.deployContract("SiriusEscrowV7", [
        ctx.token.address, ctx.kyb.address, ctx.registry.address, ctx.admin.account.address,
      ]);
      expect((await second.read.datasets()).toLowerCase()).to.equal(ctx.registry.address.toLowerCase());
      // …mais le registre ne connaît que le premier : `lock` du second échoue sur DatasetEscrowMismatch
      // (SiriusEscrowV7.sol:185). Une migration d'escrow impose donc un nouveau registre.
      expect((await ctx.registry.read.escrow()).toLowerCase()).to.equal(first.address.toLowerCase());
      expect((await ctx.registry.read.escrow()).toLowerCase()).to.not.equal(second.address.toLowerCase());
    });

    it("REP-B4 : avant la liaison, destroy() ne consulte aucun prêt", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx);
      const id = await mint(ctx, "ds-unbound");
      expect(await ctx.registry.read.escrow()).to.equal("0x0000000000000000000000000000000000000000");
      await ctx.registry.write.destroy([datasetIdHash("ds-unbound")], { account: ctx.provider.account });
      expect(await ctx.registry.read.isLive([id])).to.equal(false);
    });
  });

  describe("admin", () => {
    it("REP-B5 : admin fixé au constructeur, aucune fonction ne le change ni ne le transfère", async () => {
      const ctx = await loadFixture(fixture);
      expect((await ctx.registry.read.admin()).toLowerCase()).to.equal(ctx.admin.account.address.toLowerCase());
      const names = ctx.registry.abi
        .filter((entry) => entry.type === "function")
        .map((entry) => ("name" in entry ? entry.name : ""));
      for (const forbidden of ["transferAdmin", "setAdmin", "acceptAdmin", "renounceAdmin", "transferOwnership", "setEscrow"]) {
        expect(names).to.not.include(forbidden);
      }
      // Pas d'événement d'installation de l'admin : seul le getter `admin()` le dit.
      const events = ctx.registry.abi.filter((entry) => entry.type === "event").map((entry) => ("name" in entry ? entry.name : ""));
      expect(events.sort()).to.deep.equal(["DatasetDestroyed", "DatasetMinted", "EscrowBound", "TrainingProfileAdded"]);
    });

    it("REP-B6 : refuse admin nul et KYB nul au constructeur, mais accepte une clé simple (EOA) comme admin", async () => {
      const ctx = await loadFixture(fixture);
      const zero = "0x0000000000000000000000000000000000000000" as Address;
      await expect(hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, zero])).to.be.rejectedWith("ZeroAddress");
      await expect(hre.viem.deployContract("SiriusDatasetRegistry", [zero, ctx.admin.account.address])).to.be.rejectedWith("KybRequired");
      const eoaAdmin = await hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, ctx.other.account.address]);
      const code = await (await hre.viem.getPublicClient()).getBytecode({ address: ctx.other.account.address });
      expect(code ?? "0x").to.equal("0x");
      expect((await eoaAdmin.read.admin()).toLowerCase()).to.equal(ctx.other.account.address.toLowerCase());
    });
  });

  describe("profils d'entraînement", () => {
    it("REP-B7 : un profil erroné ajouté par l'admin reste accepté au mint pour toujours", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx);
      await ctx.registry.write.addTrainingProfile([TYPO_PROFILE], { account: ctx.admin.account });
      const id = await mint(ctx, "ds-typo", TYPO_PROFILE);
      expect((await ctx.registry.read.getDataset([id])).trainingProfile).to.equal(TYPO_PROFILE);
      expect(await ctx.registry.read.isSupportedTrainingProfile([TYPO_PROFILE])).to.equal(true);
      // Aucun retrait : le seul garde-fou est hors chaîne (le runner refuse ce profil inconnu).
      const writes = ctx.registry.abi
        .filter((entry) => entry.type === "function" && entry.stateMutability !== "view" && entry.stateMutability !== "pure")
        .map((entry) => ("name" in entry ? entry.name : ""));
      expect(writes.filter((name) => /remove|revoke|disable|pause/i.test(name))).to.deep.equal([]);
    });
  });
});
