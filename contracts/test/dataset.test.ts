import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { keccak256, toHex, type Address, type Hex } from "viem";

const YEAR = 365 * 24 * 60 * 60;
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const MERKLE_ROOT = keccak256(toHex("merkle-root-du-dataset"));
const SIZE = 1_250_000n;

async function fixture() {
  const [admin, verifier, provider, other] = await hre.viem.getWalletClients();
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [
    admin.account.address,
    verifier.account.address,
  ]);
  const registry = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address]);
  return { kyb, registry, admin, verifier, provider, other };
}

/** Donne un KYB valide à une adresse, via le chemin de consentement du sujet. */
async function grantKyb(
  ctx: Awaited<ReturnType<typeof fixture>>,
  wallet: (typeof ctx)["provider"],
): Promise<void> {
  const subject = wallet.account.address as Address;
  const verifier = ctx.verifier.account.address as Address;
  const expiresAt = (await time.latest()) + YEAR;
  const nonce = await ctx.kyb.read.nonces([subject]);
  const chainId = await (await hre.viem.getPublicClient()).getChainId();

  const signature = (await ctx.verifier.signTypedData({
    domain: { name: "SiriusKybRegistry", version: "1", chainId, verifyingContract: ctx.kyb.address },
    types: {
      KybAttestation: [
        { name: "subject", type: "address" },
        { name: "verifier", type: "address" },
        { name: "expiresAt", type: "uint40" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "KybAttestation",
    message: { subject, verifier, expiresAt, nonce },
  })) as Hex;

  await ctx.kyb.write.acceptAttestation([verifier, expiresAt, signature], { account: wallet.account });
}

describe("SiriusDatasetRegistry", () => {
  describe("gating KYB", () => {
    it("refuse la publication sans KYB valide — le gate est bloquant", async () => {
      const ctx = await loadFixture(fixture);

      await expect(
        ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account }),
      ).to.be.rejectedWith("KybRequired");
    });

    it("autorise la publication avec un KYB valide", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);

      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });

      const id = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, "ds-1"]);
      expect(await ctx.registry.read.isLive([id])).to.equal(true);
      expect(await ctx.registry.read.liveCount([ctx.provider.account.address])).to.equal(1n);
    });

    it("le contrôle KYB et la publication partagent la transaction — plus de course", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });

      // Sur le rail XRPL, `hasAcceptedKyb()` était une lecture RPC séparée de la
      // transaction qu'elle autorisait : le credential pouvait être révoqué entre
      // le contrôle et le mint. Ici la révocation mord immédiatement.
      await ctx.kyb.write.revoke([ctx.provider.account.address], { account: ctx.verifier.account });

      await expect(
        ctx.registry.write.mint(["ds-2", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account }),
      ).to.be.rejectedWith("KybRequired");
    });
  });

  describe("identité déterministe", () => {
    it("l'identifiant est connu avant la transaction et isolé par provider", async () => {
      const ctx = await loadFixture(fixture);
      const a = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, "meme-cuid"]);
      const b = await ctx.registry.read.datasetIdOf([ctx.other.account.address, "meme-cuid"]);

      // Déterminisme : plus rien à réconcilier après le mint, contrairement au
      // `mpt_issuance_id` qu'il fallait extraire des métadonnées de transaction.
      expect(a).to.equal(await ctx.registry.read.datasetIdOf([ctx.provider.account.address, "meme-cuid"]));
      expect(a).to.not.equal(b);
    });

    it("refuse un doublon, même après destruction", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });

      await expect(
        ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account }),
      ).to.be.rejectedWith("DatasetExists");

      await ctx.registry.write.destroy(["ds-1"], { account: ctx.provider.account });
      await expect(
        ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account }),
      ).to.be.rejectedWith("DatasetExists");
    });
  });

  describe("destruction et trace d'audit", () => {
    it("la destruction laisse une pierre tombale, pas un vide", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });
      const id = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, "ds-1"]);

      await ctx.registry.write.destroy(["ds-1"], { account: ctx.provider.account });

      const dataset = await ctx.registry.read.getDataset([id]);
      expect(await ctx.registry.read.isLive([id])).to.equal(false);
      expect(dataset.destroyedAt).to.not.equal(0);
      // La trace subsiste : c'est la fonctionnalité d'audit que le produit promet.
      expect(dataset.provider.toLowerCase()).to.equal(ctx.provider.account.address.toLowerCase());
      expect(dataset.cid).to.equal(CID);
      expect(await ctx.registry.read.liveCount([ctx.provider.account.address])).to.equal(0n);
    });

    it("seul le provider détruit son titre", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });

      // `destroy` dérive l'id depuis msg.sender : un tiers ne vise même pas le bon titre.
      await expect(
        ctx.registry.write.destroy(["ds-1"], { account: ctx.other.account }),
      ).to.be.rejectedWith("UnknownDataset");

      await expect(
        ctx.registry.write.destroy(["inconnu"], { account: ctx.provider.account }),
      ).to.be.rejectedWith("UnknownDataset");
    });

    it("un provider dont le KYB a expiré peut toujours détruire ses titres", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });

      await ctx.kyb.write.revoke([ctx.provider.account.address], { account: ctx.verifier.account });

      // Adosser l'effacement à un credential vivant transformerait un manquement
      // de conformité en incapacité à se conformer.
      await ctx.registry.write.destroy(["ds-1"], { account: ctx.provider.account });
      const id = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, "ds-1"]);
      expect(await ctx.registry.read.isLive([id])).to.equal(false);
    });

    it("refuse une double destruction", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });
      await ctx.registry.write.destroy(["ds-1"], { account: ctx.provider.account });

      await expect(
        ctx.registry.write.destroy(["ds-1"], { account: ctx.provider.account }),
      ).to.be.rejectedWith("AlreadyDestroyed");
    });
  });

  describe("validation et portée", () => {
    it("rejette les métadonnées invalides", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      const account = ctx.provider.account;

      await expect(
        ctx.registry.write.mint(["", CID, MERKLE_ROOT, SIZE], { account }),
      ).to.be.rejectedWith("EmptyDatasetId");

      await expect(
        ctx.registry.write.mint(["a", "", MERKLE_ROOT, SIZE], { account }),
      ).to.be.rejectedWith("InvalidCid");

      await expect(
        ctx.registry.write.mint(["b", "x".repeat(129), MERKLE_ROOT, SIZE], { account }),
      ).to.be.rejectedWith("InvalidCid");

      await expect(
        ctx.registry.write.mint(["c", CID, `0x${"00".repeat(32)}` as Hex, SIZE], { account }),
      ).to.be.rejectedWith("InvalidMerkleRoot");

      for (const size of [0n, 16n * 1024n * 1024n + 1n]) {
        await expect(
          ctx.registry.write.mint([`d-${size}`, CID, MERKLE_ROOT, size], { account }),
        ).to.be.rejectedWith("InvalidSize");
      }
    });

    it("matchesScope confirme le titre avant tout déchiffrement", async () => {
      const ctx = await loadFixture(fixture);
      await grantKyb(ctx, ctx.provider);
      await ctx.registry.write.mint(["ds-1", CID, MERKLE_ROOT, SIZE], { account: ctx.provider.account });
      const id = await ctx.registry.read.datasetIdOf([ctx.provider.account.address, "ds-1"]);
      const provider = ctx.provider.account.address;

      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, CID])).to.equal(true);
      expect(
        await ctx.registry.read.matchesScope([id, ctx.other.account.address, MERKLE_ROOT, CID]),
      ).to.equal(false);
      expect(
        await ctx.registry.read.matchesScope([id, provider, keccak256(toHex("autre")), CID]),
      ).to.equal(false);
      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, "autre-cid"])).to.equal(false);

      // Un titre détruit ne doit plus jamais autoriser un calcul.
      await ctx.registry.write.destroy(["ds-1"], { account: ctx.provider.account });
      expect(await ctx.registry.read.matchesScope([id, provider, MERKLE_ROOT, CID])).to.equal(false);
    });

    it("n'expose aucun champ de texte libre — contrainte RGPD", async () => {
      const ctx = await loadFixture(fixture);
      // Les événements sont éternels et finissent en blob sur L1 : ni le nom ni la
      // description du dataset ne doivent pouvoir y être écrits.
      const inputs = ctx.registry.abi
        .filter((entry) => entry.type === "function" && entry.name === "mint")
        .flatMap((entry) => ("inputs" in entry ? entry.inputs.map((input) => input.name) : []));

      expect(inputs).to.deep.equal(["datasetId", "cid", "merkleRoot", "sizeBytes"]);
      expect(inputs).to.not.include("name");
      expect(inputs).to.not.include("description");
    });
  });
});
