import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, toHex, zeroAddress, type Address, type Hex } from "viem";
import { cidHash, datasetIdHash } from "../../src/lib/evm/dataset-key";

/**
 * Registre v6 (docs/UPLOAD-1GO.md §10) : taille maximale réglable par l'admin sous un plafond
 * gravé de 1 Gio, et import par l'admin des titres vivants du registre v5, sans pouvoir en créer
 * ni en modifier. Le v5 utilisé ici est une copie à l'identique du contrat déployé.
 */

const YEAR = 365 * 24 * 60 * 60;
const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;
const MERKLE_ROOT = keccak256(toHex("racine-du-clair"));
const LINEAR = keccak256(toHex("sirius.training-profile.v1:linear_regression:1.0.0"));
const TREES = keccak256(toHex("sirius.training-profile.v1:gradient_boosted_trees:1.1.0"));

async function fixture() {
  const [admin, verifier, provider, other] = await hre.viem.getWalletClients();
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [admin.account.address, verifier.account.address]);
  const v5 = await hre.viem.deployContract("SiriusDatasetRegistryV5", [kyb.address, admin.account.address]);
  const registry = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, admin.account.address, v5.address]);
  const fresh = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, admin.account.address, zeroAddress]);
  const publicClient = await hre.viem.getPublicClient();
  return { kyb, v5, registry, fresh, admin, verifier, provider, other, publicClient };
}

type Ctx = Awaited<ReturnType<typeof fixture>>;

async function grantKyb(ctx: Ctx, wallet: Ctx["provider"]): Promise<void> {
  const subject = wallet.account.address as Address;
  const verifier = ctx.verifier.account.address as Address;
  const expiresAt = (await time.latest()) + YEAR;
  const nonce = await ctx.kyb.read.nonces([subject]);
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
    message: { subject, verifier, expiresAt, nonce, verifierEpoch: await ctx.kyb.read.verifierEpoch([verifier]) },
  })) as Hex;
  await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], { account: wallet.account });
}

/** Titre minté sur le v5 par le fournisseur, comme en production avant la migration. */
async function mintOnV5(ctx: Ctx, name: string, profile = LINEAR, size = 2n * MIB): Promise<Hex> {
  await ctx.v5.write.mint([datasetIdHash(name), cidHash(`cid-${name}`), MERKLE_ROOT, size, profile], { account: ctx.provider.account });
  return ctx.v5.read.datasetIdOf([ctx.provider.account.address, datasetIdHash(name)]);
}

describe("SiriusDatasetRegistry v6 : gros datasets et import sans perte", () => {
  describe("taille maximale", () => {
    it("démarre à 16 Mio, le plafond du v5, et refuse un mint au-delà", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      expect(await ctx.registry.read.VERSION()).to.equal("sirius-dataset-v6");
      expect(await ctx.registry.read.maxSizeBytes()).to.equal(16n * MIB);
      expect(await ctx.registry.read.MAX_SIZE_CEILING()).to.equal(GIB);
      await ctx.registry.write.mint([datasetIdHash("ok"), cidHash("cid-ok"), MERKLE_ROOT, 16n * MIB, LINEAR], { account: ctx.provider.account });
      await expect(
        ctx.registry.write.mint([datasetIdHash("gros"), cidHash("cid-gros"), MERKLE_ROOT, 16n * MIB + 1n, LINEAR], { account: ctx.provider.account }),
      ).to.be.rejectedWith("InvalidSize");
    });

    it("l'admin seul la relève jusqu'à 1 Gio, jamais au-delà ni à zéro", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await expect(ctx.registry.write.setMaxSizeBytes([GIB], { account: ctx.other.account })).to.be.rejectedWith("NotAdmin");
      await expect(ctx.registry.write.setMaxSizeBytes([GIB + 1n], { account: ctx.admin.account })).to.be.rejectedWith("InvalidSize");
      await expect(ctx.registry.write.setMaxSizeBytes([0n], { account: ctx.admin.account })).to.be.rejectedWith("InvalidSize");

      await ctx.registry.write.setMaxSizeBytes([GIB], { account: ctx.admin.account });
      const [changed] = await ctx.registry.getEvents.MaxSizeChanged();
      expect(changed.args).to.deep.equal({ previousMaxSizeBytes: 16n * MIB, maxSizeBytes: GIB });
      await ctx.registry.write.mint([datasetIdHash("1go"), cidHash("cid-1go"), MERKLE_ROOT, GIB, LINEAR], { account: ctx.provider.account });

      // Abaisser la limite ne touche pas un titre existant : la taille n'est vérifiée qu'au mint.
      await ctx.registry.write.setMaxSizeBytes([MIB], { account: ctx.admin.account });
      const id = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, datasetIdHash("1go")]);
      expect(await ctx.registry.read.isLive([id])).to.equal(true);
      expect((await ctx.registry.read.getDataset([id])).sizeBytes).to.equal(GIB);
    });
  });

  describe("registre précédent", () => {
    it("n'accepte au constructeur qu'un registre v5 déployé, ou aucun", async () => {
      const ctx = await loadFixture(fixture);
      await expect(
        hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, ctx.admin.account.address, ctx.other.account.address]),
      ).to.be.rejectedWith("InvalidPreviousRegistry");
      await expect(
        hre.viem.deployContract("SiriusDatasetRegistry", [ctx.kyb.address, ctx.admin.account.address, ctx.registry.address]),
      ).to.be.rejectedWith("InvalidPreviousRegistry");
      expect((await ctx.registry.read.previousRegistry()).toLowerCase()).to.equal(ctx.v5.address.toLowerCase());
      expect(await ctx.fresh.read.previousRegistry()).to.equal(zeroAddress);
    });
  });

  describe("import des titres", () => {
    it("recopie un titre vivant à l'identique, sous le même identifiant", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.v5.write.addTrainingProfile([TREES], { account: ctx.admin.account });
      const linear = await mintOnV5(ctx, "lin");
      const trees = await mintOnV5(ctx, "arbres", TREES, 9n * MIB);

      await ctx.registry.write.importTitles([[linear, trees]], { account: ctx.admin.account });

      for (const id of [linear, trees]) {
        expect(await ctx.registry.read.getDataset([id])).to.deep.equal(await ctx.v5.read.getDataset([id]));
      }
      expect(await ctx.registry.read.liveCount([ctx.provider.account.address])).to.equal(2n);
      // Le profil des arbres n'est pas listé dans ce registre : il reste utilisable pour le titre importé.
      expect(await ctx.registry.read.isSupportedTrainingProfile([TREES])).to.equal(false);
      expect(await ctx.registry.read.isLiveForProviderAndProfile([trees, ctx.provider.account.address, TREES])).to.equal(true);
      expect(await ctx.registry.read.matchesScope([linear, ctx.provider.account.address, MERKLE_ROOT, cidHash("cid-lin"), LINEAR])).to.equal(true);

      const events = await ctx.registry.getEvents.DatasetImported();
      expect(events.map((event) => event.args.datasetId)).to.deep.equal([linear, trees]);
      expect(events[1].args).to.include({ sizeBytes: 9n * MIB, trainingProfile: TREES, merkleRoot: MERKLE_ROOT });
      expect(await ctx.registry.getEvents.DatasetMinted()).to.have.length(0);

      // Le titre importé appartient toujours à son fournisseur : lui seul le détruit, et l'identifiant ne se remint pas.
      await expect(
        ctx.registry.write.mint([datasetIdHash("lin"), cidHash("autre"), MERKLE_ROOT, MIB, LINEAR], { account: ctx.provider.account }),
      ).to.be.rejectedWith("DatasetExists");
      await ctx.registry.write.destroy([datasetIdHash("lin")], { account: ctx.provider.account });
      expect(await ctx.registry.read.isLive([linear])).to.equal(false);
      expect(await ctx.registry.read.liveCount([ctx.provider.account.address])).to.equal(1n);
    });

    it("refuse un titre détruit, inconnu ou déjà importé, et n'applique jamais un lot à moitié", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      const live = await mintOnV5(ctx, "vivant");
      const destroyed = await mintOnV5(ctx, "detruit");
      await ctx.v5.write.destroy([datasetIdHash("detruit")], { account: ctx.provider.account });
      const unknown = keccak256(toHex("jamais-minte"));

      await expect(ctx.registry.write.importTitles([[destroyed]], { account: ctx.admin.account })).to.be.rejectedWith("NotImportable");
      await expect(ctx.registry.write.importTitles([[unknown]], { account: ctx.admin.account })).to.be.rejectedWith("NotImportable");
      await expect(ctx.registry.write.importTitles([[live, destroyed]], { account: ctx.admin.account })).to.be.rejectedWith("NotImportable");
      expect(await ctx.registry.read.isLive([live])).to.equal(false);

      await ctx.registry.write.importTitles([[live]], { account: ctx.admin.account });
      await expect(ctx.registry.write.importTitles([[live]], { account: ctx.admin.account })).to.be.rejectedWith("DatasetExists");
    });

    it("est réservé à l'admin, à un registre qui a un prédécesseur, et à des lots de 1 à 100", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      const id = await mintOnV5(ctx, "titre");
      await expect(ctx.registry.write.importTitles([[id]], { account: ctx.provider.account })).to.be.rejectedWith("NotAdmin");
      await expect(ctx.registry.write.importTitles([[id]], { account: ctx.other.account })).to.be.rejectedWith("NotAdmin");
      await expect(ctx.fresh.write.importTitles([[id]], { account: ctx.admin.account })).to.be.rejectedWith("NoPreviousRegistry");
      await expect(ctx.registry.write.importTitles([[]], { account: ctx.admin.account })).to.be.rejectedWith("InvalidBatch");
      const tooMany = Array.from({ length: 101 }, () => id);
      await expect(ctx.registry.write.importTitles([tooMany], { account: ctx.admin.account })).to.be.rejectedWith("InvalidBatch");
    });

    it("un titre importé s'emprunte par un escrow v7 lié au nouveau registre", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      const id = await mintOnV5(ctx, "empruntable");
      await ctx.registry.write.importTitles([[id]], { account: ctx.admin.account });
      const usdc = await hre.viem.deployContract("MockUsdc");
      const escrow = await hre.viem.deployContract("SiriusEscrowV7", [usdc.address, ctx.kyb.address, ctx.registry.address, ctx.other.account.address]);
      await ctx.registry.write.bindEscrow([escrow.address], { account: ctx.admin.account });
      expect((await escrow.read.datasets()).toLowerCase()).to.equal(ctx.registry.address.toLowerCase());
      expect(await escrow.read.activeLoansForDataset([id])).to.equal(0n);
      // Ce que l'escrow v7 vérifie au verrouillage d'un prêt.
      expect(await ctx.registry.read.isLiveForProviderAndProfile([id, ctx.provider.account.address, LINEAR])).to.equal(true);
    });
  });
});
