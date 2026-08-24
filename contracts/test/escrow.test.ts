import { expect } from "chai";
import { createHash, randomBytes } from "node:crypto";
import hre from "hardhat";
import { keccak256, parseEther, toBytes, type Address, type Hex } from "viem";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

/**
 * Suite du contrat qui porte le cœur de valeur de Sirius : c'est lui qui garantit
 * qu'on ne peut jamais payer le provider sans publier le préimage, ni publier le
 * préimage sans payer le provider.
 */

const DAY = 24 * 60 * 60;

/** Reproduit exactement `deriveKey(masterKey, "escrow:<borrower>:<loanId>")` du TEE. */
function teePreimage(): { preimage: Hex; hashlock: Hex } {
  const raw = randomBytes(32);
  return {
    preimage: `0x${raw.toString("hex")}`,
    hashlock: `0x${createHash("sha256").update(raw).digest("hex")}`,
  };
}

async function fixture() {
  const [deployer, borrower, provider, stranger] = await hre.viem.getWalletClients();
  const escrow = await hre.viem.deployContract("SiriusEscrow");
  const publicClient = await hre.viem.getPublicClient();
  return { escrow, publicClient, deployer, borrower, provider, stranger };
}

async function lockLoan(
  ctx: Awaited<ReturnType<typeof fixture>>,
  options: { loanId?: string; amount?: bigint; challengeDays?: number; provider?: Address } = {},
) {
  const { preimage, hashlock } = teePreimage();
  const loanId = options.loanId ?? `loan_${randomBytes(8).toString("hex")}`;
  const amount = options.amount ?? parseEther("0.25");
  const providerAddress = options.provider ?? ctx.provider.account.address;

  await ctx.escrow.write.lock(
    [providerAddress, hashlock, options.challengeDays ?? 7, loanId],
    { account: ctx.borrower.account, value: amount },
  );

  const loanKey = await ctx.escrow.read.loanKeyOf([
    ctx.borrower.account.address,
    keccak256(toBytes(loanId)),
  ]);

  return { loanKey, preimage, hashlock, loanId, amount, providerAddress };
}

describe("SiriusEscrow", () => {
  describe("compatibilité avec l'enclave", () => {
    it("le hashlock du contrat est celui que le TEE calcule en Node", async () => {
      const ctx = await loadFixture(fixture);
      const { preimage, hashlock, loanKey } = await lockLoan(ctx);

      // Si cette égalité tombe, aucun escrow ne peut jamais être débloqué.
      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      const loan = await ctx.escrow.read.getLoan([loanKey]);
      expect(loan.hashlock).to.equal(hashlock);
      expect(loan.preimage).to.equal(preimage);
    });

    it("refuse un préimage qui n'ouvre pas le hashlock", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey } = await lockLoan(ctx);
      const other = teePreimage();

      await expect(
        ctx.escrow.write.release([loanKey, other.preimage], { account: ctx.stranger.account }),
      ).to.be.rejectedWith("InvalidPreimage");
    });
  });

  describe("atomicité paiement ↔ révélation", () => {
    it("release publie le préimage ET crédite le provider dans la même transaction", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, preimage, amount, providerAddress } = await lockLoan(ctx);

      expect(await ctx.escrow.read.creditOf([providerAddress])).to.equal(0n);
      const [revealedBefore] = await ctx.escrow.read.preimageOf([loanKey]);
      expect(revealedBefore).to.equal(false);

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });

      const [revealedAfter, published] = await ctx.escrow.read.preimageOf([loanKey]);
      expect(revealedAfter).to.equal(true);
      expect(published).to.equal(preimage);
      expect(await ctx.escrow.read.creditOf([providerAddress])).to.equal(amount);
    });

    it("un provider qui rejette l'ETH ne peut ni bloquer la publication ni perdre ses fonds", async () => {
      const ctx = await loadFixture(fixture);
      const hostile = await hre.viem.deployContract("RevertingPayee");
      const { loanKey, preimage, amount } = await lockLoan(ctx, { provider: hostile.address });

      // Le grief canonique en EVM — impossible sur XRPL où un Payment ne peut pas échouer.
      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });

      // La publication a bien eu lieu malgré un provider hostile.
      const [revealed, published] = await ctx.escrow.read.preimageOf([loanKey]);
      expect(revealed).to.equal(true);
      expect(published).to.equal(preimage);

      // Les fonds restent dus, ils ne sont pas perdus : c'est le retrait qui échoue.
      expect(await ctx.escrow.read.creditOf([hostile.address])).to.equal(amount);
      await expect(
        ctx.escrow.write.withdrawFor([hostile.address], { account: ctx.stranger.account }),
      ).to.be.rejectedWith("TransferFailed");
      expect(await ctx.escrow.read.creditOf([hostile.address])).to.equal(amount);
    });

    it("un provider qui brûle tout le gas ne change pas l'issue", async () => {
      const ctx = await loadFixture(fixture);
      const hostile = await hre.viem.deployContract("GasBurningPayee");
      const { loanKey, preimage } = await lockLoan(ctx, { provider: hostile.address });

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      const [revealed] = await ctx.escrow.read.preimageOf([loanKey]);
      expect(revealed).to.equal(true);
    });
  });

  describe("fenêtre de release et fuite par calldata", () => {
    it("release reste possible après le deadline tant que le refund n'a pas été exécuté", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, preimage, amount, providerAddress } = await lockLoan(ctx, { challengeDays: 1 });

      await time.increase(2 * DAY);

      // C'est le correctif de la fuite par calldata : si release revertait ici, son calldata
      // — qui contient le préimage — resterait lisible via eth_getTransactionByHash, le
      // borrower ouvrirait sa capsule puis se ferait rembourser.
      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });

      expect(await ctx.escrow.read.creditOf([providerAddress])).to.equal(amount);
    });

    it("l'exécution du refund ferme définitivement la fenêtre de release", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, preimage, amount } = await lockLoan(ctx, { challengeDays: 1 });

      await time.increase(2 * DAY);
      await ctx.escrow.write.refund([loanKey], { account: ctx.stranger.account });

      expect(await ctx.escrow.read.creditOf([ctx.borrower.account.address])).to.equal(amount);
      await expect(
        ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account }),
      ).to.be.rejectedWith("LoanNotLocked");
    });

    it("refuse le refund avant l'échéance", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey } = await lockLoan(ctx, { challengeDays: 7 });

      await expect(
        ctx.escrow.write.refund([loanKey], { account: ctx.borrower.account }),
      ).to.be.rejectedWith("ChallengePeriodActive");
    });

    it("refuse un second release après release", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, preimage } = await lockLoan(ctx);

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      await expect(
        ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account }),
      ).to.be.rejectedWith("LoanNotLocked");
    });

    it("refuse le refund après un release", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, preimage } = await lockLoan(ctx, { challengeDays: 1 });

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      await time.increase(2 * DAY);
      await expect(
        ctx.escrow.write.refund([loanKey], { account: ctx.borrower.account }),
      ).to.be.rejectedWith("LoanNotLocked");
    });
  });

  describe("retrait", () => {
    it("withdrawFor est permissionless et n'envoie qu'au bénéficiaire enregistré", async () => {
      const ctx = await loadFixture(fixture);
      const payee = await hre.viem.deployContract("StoringPayee");
      const { loanKey, preimage, amount } = await lockLoan(ctx, { provider: payee.address });

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });

      // Un contrat qui reçoit mais ne peut pas émettre de transaction serait autrement
      // définitivement bloqué : aucun admin n'existe pour le secourir.
      await ctx.escrow.write.withdrawFor([payee.address], { account: ctx.stranger.account });

      expect(await payee.read.received()).to.equal(amount);
      expect(await ctx.escrow.read.creditOf([payee.address])).to.equal(0n);
    });

    it("refuse un retrait sans crédit", async () => {
      const ctx = await loadFixture(fixture);
      await expect(
        ctx.escrow.write.withdrawFor([ctx.provider.account.address], { account: ctx.stranger.account }),
      ).to.be.rejectedWith("NothingToWithdraw");
    });

    it("bloque la réentrance sur le retrait et interdit le double paiement", async () => {
      const ctx = await loadFixture(fixture);
      const attacker = await hre.viem.deployContract("ReentrantPayee", [ctx.escrow.address]);
      const { loanKey, preimage, amount } = await lockLoan(ctx, { provider: attacker.address });

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      await ctx.escrow.write.withdrawFor([attacker.address], { account: ctx.stranger.account });

      expect(await attacker.read.attempted()).to.equal(true);
      expect(await attacker.read.reentryReverted()).to.equal(true);
      expect(await ctx.escrow.read.creditOf([attacker.address])).to.equal(0n);
      expect(await ctx.publicClient.getBalance({ address: attacker.address })).to.equal(amount);
    });
  });

  describe("validation à la création", () => {
    it("rejette les paramètres invalides", async () => {
      const ctx = await loadFixture(fixture);
      const { hashlock } = teePreimage();
      const provider = ctx.provider.account.address;
      const value = parseEther("0.1");

      await expect(
        ctx.escrow.write.lock([provider, hashlock, 7, "l1"], { account: ctx.borrower.account, value: 0n }),
      ).to.be.rejectedWith("ZeroAmount");

      await expect(
        ctx.escrow.write.lock(
          ["0x0000000000000000000000000000000000000000", hashlock, 7, "l2"],
          { account: ctx.borrower.account, value },
        ),
      ).to.be.rejectedWith("InvalidProvider");

      // Un provider ne peut pas emprunter son propre dataset (règle métier existante).
      await expect(
        ctx.escrow.write.lock([ctx.borrower.account.address, hashlock, 7, "l3"], {
          account: ctx.borrower.account,
          value,
        }),
      ).to.be.rejectedWith("SelfDealing");

      for (const days of [0, 31]) {
        await expect(
          ctx.escrow.write.lock([provider, hashlock, days, `l-${days}`], {
            account: ctx.borrower.account,
            value,
          }),
        ).to.be.rejectedWith("InvalidChallengePeriod");
      }

      await expect(
        ctx.escrow.write.lock([provider, hashlock, 7, ""], { account: ctx.borrower.account, value }),
      ).to.be.rejectedWith("EmptyLoanId");
    });

    it("impose un montant plancher contre le spam d'événements", async () => {
      const ctx = await loadFixture(fixture);
      const { hashlock } = teePreimage();
      const floor = await ctx.escrow.read.MIN_AMOUNT();

      // `lock` étant permissionless, sans plancher on empoisonne le flux d'événements
      // d'un provider et on gonfle le storage pour un wei par entrée.
      await expect(
        ctx.escrow.write.lock([ctx.provider.account.address, hashlock, 7, "dust"], {
          account: ctx.borrower.account,
          value: floor - 1n,
        }),
      ).to.be.rejectedWith("AmountTooSmall");

      await ctx.escrow.write.lock([ctx.provider.account.address, hashlock, 7, "au-plancher"], {
        account: ctx.borrower.account,
        value: floor,
      });
    });

    it("rejette un hashlock dégénéré", async () => {
      const ctx = await loadFixture(fixture);
      const provider = ctx.provider.account.address;
      const value = parseEther("0.1");
      const zeroPreimageHash = `0x${createHash("sha256").update(Buffer.alloc(32)).digest("hex")}` as Hex;

      for (const bad of [`0x${"00".repeat(32)}` as Hex, zeroPreimageHash]) {
        await expect(
          ctx.escrow.write.lock([provider, bad, 7, `bad-${bad.slice(2, 10)}`], {
            account: ctx.borrower.account,
            value,
          }),
        ).to.be.rejectedWith("InvalidHashlock");
      }
    });

    it("interdit de réutiliser une clé de prêt, même après clôture", async () => {
      const ctx = await loadFixture(fixture);
      const loanId = "loan-unique";
      const { preimage } = await lockLoan(ctx, { loanId });
      const { hashlock: other } = teePreimage();

      await expect(
        ctx.escrow.write.lock([ctx.provider.account.address, other, 7, loanId], {
          account: ctx.borrower.account,
          value: parseEther("0.1"),
        }),
      ).to.be.rejectedWith("LoanExists");

      // Toujours interdit après règlement : un préimage publié ne doit jamais être rejouable.
      const loanKey = await ctx.escrow.read.loanKeyOf([
        ctx.borrower.account.address,
        keccak256(toBytes(loanId)),
      ]);
      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      await expect(
        ctx.escrow.write.lock([ctx.provider.account.address, other, 7, loanId], {
          account: ctx.borrower.account,
          value: parseEther("0.1"),
        }),
      ).to.be.rejectedWith("LoanExists");
    });

    it("isole les prêts de deux borrowers portant le même loanId", async () => {
      const ctx = await loadFixture(fixture);
      const { hashlock } = teePreimage();
      const loanId = "collision";

      await ctx.escrow.write.lock([ctx.provider.account.address, hashlock, 7, loanId], {
        account: ctx.borrower.account,
        value: parseEther("0.1"),
      });
      // Le même identifiant depuis une autre adresse doit occuper un autre emplacement.
      await ctx.escrow.write.lock([ctx.provider.account.address, hashlock, 7, loanId], {
        account: ctx.stranger.account,
        value: parseEther("0.1"),
      });

      const a = await ctx.escrow.read.loanKeyOf([ctx.borrower.account.address, keccak256(toBytes(loanId))]);
      const b = await ctx.escrow.read.loanKeyOf([ctx.stranger.account.address, keccak256(toBytes(loanId))]);
      expect(a).to.not.equal(b);
    });
  });

  describe("comptabilité et contrôle de portée", () => {
    it("la solvabilité tient à chaque transition et l'ETH forcé est inerte", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, preimage, amount } = await lockLoan(ctx);

      // `.gte` de chai 4 ne gère pas les bigint : on compare explicitement.
      const solvent = (l: bigint, o: bigint, b: bigint) => b >= l + o;

      let [locked, owed, balance] = await ctx.escrow.read.accounting();
      expect(locked).to.equal(amount);
      expect(owed).to.equal(0n);
      expect(solvent(locked, owed, balance)).to.equal(true);

      await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });
      [locked, owed, balance] = await ctx.escrow.read.accounting();
      expect(locked).to.equal(0n);
      expect(owed).to.equal(amount);
      expect(solvent(locked, owed, balance)).to.equal(true);

      await ctx.escrow.write.withdrawFor([ctx.provider.account.address], { account: ctx.stranger.account });
      [locked, owed] = await ctx.escrow.read.accounting();
      expect(locked).to.equal(0n);
      expect(owed).to.equal(0n);
    });

    it("le compteur d'événements est monotone pour détecter un log manquant", async () => {
      const ctx = await loadFixture(fixture);
      const first = await lockLoan(ctx);
      const [, , , afterFirst] = await ctx.escrow.read.accounting();
      await lockLoan(ctx);
      const [, , , afterSecond] = await ctx.escrow.read.accounting();
      expect(afterSecond).to.equal(afterFirst + 1n);

      await ctx.escrow.write.release([first.loanKey, first.preimage], { account: ctx.stranger.account });
      const [, , , afterRelease] = await ctx.escrow.read.accounting();
      expect(afterRelease).to.equal(afterSecond + 1n);
    });

    it("matchesScope remplace la double vérification XRPL en un seul appel", async () => {
      const ctx = await loadFixture(fixture);
      const { loanKey, hashlock, amount, providerAddress } = await lockLoan(ctx, { challengeDays: 7 });
      const borrower = ctx.borrower.account.address;
      const margin = BigInt(30 * 60); // marge > finalité réelle (~13 min)

      expect(
        await ctx.escrow.read.matchesScope([loanKey, borrower, providerAddress, amount, hashlock, margin]),
      ).to.equal(true);

      // Chaque champ discordant doit invalider la portée.
      expect(
        await ctx.escrow.read.matchesScope([
          loanKey, borrower, providerAddress, amount + 1n, hashlock, margin,
        ]),
      ).to.equal(false);
      expect(
        await ctx.escrow.read.matchesScope([
          loanKey, ctx.stranger.account.address, providerAddress, amount, hashlock, margin,
        ]),
      ).to.equal(false);

      // Trop proche de l'expiration : le runner doit refuser de lancer le calcul.
      await time.increase(7 * DAY - 10 * 60);
      expect(
        await ctx.escrow.read.matchesScope([loanKey, borrower, providerAddress, amount, hashlock, margin]),
      ).to.equal(false);
    });
  });
});
