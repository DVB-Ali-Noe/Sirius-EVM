import assert from "node:assert/strict";
import { expect } from "chai";
import { createHash, randomBytes } from "node:crypto";
import hre from "hardhat";
import { type Address, type Hex } from "viem";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { loanIdHash } from "../../src/lib/evm/loan-key";

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const ONE_USDC = 1_000_000n;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function teePreimage(): { preimage: Hex; hashlock: Hex } {
  const preimage = randomBytes(32);
  return {
    preimage: `0x${preimage.toString("hex")}`,
    hashlock: `0x${createHash("sha256").update(preimage).digest("hex")}`,
  };
}

async function fixture() {
  const [admin, verifier, borrower, provider, stranger] = await hre.viem.getWalletClients();
  const usdc = await hre.viem.deployContract("MockUsdc");
  const kyb = await hre.viem.deployContract("SiriusKybRegistry", [
    admin.account.address,
    verifier.account.address,
  ]);
  const grantKyb = async (wallet: typeof borrower) => {
    const subject = wallet.account.address;
    const expiresAt = (await time.latest()) + YEAR;
    const nonce = await kyb.read.nonces([subject]);
    const chainId = await (await hre.viem.getPublicClient()).getChainId();
    const signature = await verifier.signTypedData({
      domain: { name: "SiriusKybRegistry", version: "1", chainId, verifyingContract: kyb.address },
      types: {
        KybAttestation: [
          { name: "subject", type: "address" },
          { name: "verifier", type: "address" },
          { name: "expiresAt", type: "uint40" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "KybAttestation",
      message: { subject, verifier: verifier.account.address, expiresAt, nonce },
    });
    await kyb.write.acceptAttestation([verifier.account.address, expiresAt, signature], { account: wallet.account });
  };

  await Promise.all([grantKyb(borrower), grantKyb(provider), grantKyb(stranger)]);
  const escrow = await hre.viem.deployContract("SiriusEscrow", [usdc.address, kyb.address]);
  const publicClient = await hre.viem.getPublicClient();
  await usdc.write.mint([borrower.account.address, 1_000_000n * ONE_USDC]);
  await usdc.write.mint([stranger.account.address, 1_000_000n * ONE_USDC]);
  return { escrow, kyb, usdc, publicClient, admin, verifier, borrower, provider, stranger };
}

async function lockLoan(
  ctx: Awaited<ReturnType<typeof fixture>>,
  options: { loanId?: string; amount?: bigint; challengeDays?: number; provider?: Address; borrower?: 2 | 4 } = {},
) {
  const { preimage, hashlock } = teePreimage();
  const loanId = options.loanId ?? `loan_${randomBytes(8).toString("hex")}`;
  const amount = options.amount ?? 25n * ONE_USDC;
  const provider = options.provider ?? ctx.provider.account.address;
  const borrower = options.borrower === 4 ? ctx.stranger : ctx.borrower;

  await ctx.usdc.write.approve([ctx.escrow.address, amount], { account: borrower.account });
  await ctx.escrow.write.lock(
    [provider, amount, hashlock, options.challengeDays ?? 7, loanIdHash(loanId)],
    { account: borrower.account },
  );
  const loanKey = await ctx.escrow.read.loanKeyOf([borrower.account.address, loanIdHash(loanId)]);
  return { loanKey, preimage, hashlock, loanId, amount, provider, borrower };
}

describe("SiriusEscrow USDC", () => {
  it("verrouille les USDC et publie le préimage en créditant le provider", async () => {
    const ctx = await loadFixture(fixture);
    const { loanKey, preimage, amount, provider } = await lockLoan(ctx);

    expect(await ctx.usdc.read.balanceOf([ctx.escrow.address])).to.equal(amount);
    await ctx.escrow.write.release([loanKey, preimage], { account: ctx.stranger.account });

    const [revealed, published] = await ctx.escrow.read.preimageOf([loanKey]);
    expect(revealed).to.equal(true);
    expect(published).to.equal(preimage);
    expect(await ctx.escrow.read.creditOf([provider])).to.equal(amount);

    await ctx.escrow.write.withdrawFor([provider], { account: ctx.stranger.account });
    expect(await ctx.usdc.read.balanceOf([provider])).to.equal(amount);
    expect(await ctx.escrow.read.creditOf([provider])).to.equal(0n);
  });

  it("refuse un préimage incorrect et ne débite jamais deux fois", async () => {
    const ctx = await loadFixture(fixture);
    const { loanKey, amount } = await lockLoan(ctx);
    const other = teePreimage();

    await expect(ctx.escrow.write.release([loanKey, other.preimage], { account: ctx.stranger.account }))
      .to.be.rejectedWith("InvalidPreimage");
    expect(await ctx.escrow.read.creditOf([ctx.provider.account.address])).to.equal(0n);

    const [locked, owed, balance] = await ctx.escrow.read.accounting();
    expect(locked).to.equal(amount);
    expect(owed).to.equal(0n);
    expect(balance).to.equal(amount);
  });

  it("ferme la fenêtre de release à l'échéance", async () => {
    const ctx = await loadFixture(fixture);
    const { loanKey, preimage, amount, borrower } = await lockLoan(ctx, { challengeDays: 1 });

    await expect(ctx.escrow.write.refund([loanKey], { account: ctx.stranger.account }))
      .to.be.rejectedWith("ChallengePeriodActive");
    await time.increase(2 * DAY);
    await expect(ctx.escrow.write.release([loanKey, preimage], { account: ctx.provider.account }))
      .to.be.rejectedWith("ChallengePeriodElapsed");
    await ctx.escrow.write.refund([loanKey], { account: ctx.stranger.account });

    await ctx.escrow.write.withdrawFor([borrower.account.address], { account: ctx.provider.account });
    expect(await ctx.usdc.read.balanceOf([borrower.account.address])).to.equal(1_000_000n * ONE_USDC);
    expect(await ctx.usdc.read.balanceOf([ctx.escrow.address])).to.equal(0n);
    expect(amount).to.equal(25n * ONE_USDC);
  });

  it("exige KYB, USDC exact et termes non ambigus", async () => {
    const ctx = await loadFixture(fixture);
    const { hashlock } = teePreimage();
    const borrower = ctx.borrower.account;

    await expect(ctx.escrow.write.lock([ctx.provider.account.address, ONE_USDC, hashlock, 7, loanIdHash("no-allowance")], {
      account: borrower,
    })).to.be.rejectedWith("TokenTransferFailed");

    await ctx.usdc.write.approve([ctx.escrow.address, ONE_USDC], { account: borrower });
    await expect(ctx.escrow.write.lock([ctx.provider.account.address, 999n, hashlock, 7, loanIdHash("dust")], {
      account: borrower,
    })).to.be.rejectedWith("AmountTooSmall");
    await expect(ctx.escrow.write.lock([borrower.address, ONE_USDC, hashlock, 7, loanIdHash("self")], {
      account: borrower,
    })).to.be.rejectedWith("SelfDealing");
    await expect(ctx.escrow.write.lock([ctx.provider.account.address, ONE_USDC, hashlock, 0, loanIdHash("days")], {
      account: borrower,
    })).to.be.rejectedWith("InvalidChallengePeriod");
    await expect(ctx.escrow.write.lock([ctx.provider.account.address, ONE_USDC, hashlock, 7, ZERO_HASH], {
      account: borrower,
    })).to.be.rejectedWith("InvalidLoanId");

    await ctx.kyb.write.revoke([ctx.borrower.account.address], { account: ctx.verifier.account });
    await expect(ctx.escrow.write.lock([ctx.provider.account.address, ONE_USDC, hashlock, 7, loanIdHash("revoked")], {
      account: borrower,
    })).to.be.rejectedWith("KybRequired");
  });

  it("dérive le montant plancher de la précision du token, pas d'une constante", async () => {
    const ctx = await loadFixture(fixture);

    // MockUsdc expose 6 décimales : le plancher doit valoir 0,001 USDC, soit 1 000 unités.
    assert.equal(await ctx.escrow.read.MIN_AMOUNT(), 1_000n);

    // Le même contrat déployé contre un token à 18 décimales doit remonter son plancher
    // d'autant. Une constante écrite en dur ferait ici un plancher de poussière, et
    // laisserait passer des prêts dont le gas dépasse le montant.
    const usdc18 = await hre.viem.deployContract("MockUsdc18");
    const escrow18 = await hre.viem.deployContract("SiriusEscrow", [usdc18.address, ctx.kyb.address]);
    assert.equal(await escrow18.read.MIN_AMOUNT(), 10n ** 15n);
  });

  it("refuse un token dont la précision est implausible", async () => {
    const ctx = await loadFixture(fixture);
    const usdc0 = await hre.viem.deployContract("MockUsdc0");
    await expect(
      hre.viem.deployContract("SiriusEscrow", [usdc0.address, ctx.kyb.address]),
    ).to.be.rejectedWith("UnsupportedUsdcDecimals");
  });

  it("refuse un token à frais et une adresse sans code", async () => {
    const ctx = await loadFixture(fixture);
    await expect(
      hre.viem.deployContract("SiriusEscrow", [ctx.borrower.account.address, ctx.kyb.address]),
    ).to.be.rejectedWith("InvalidUsdcContract");

    const feeUsdc = await hre.viem.deployContract("MockFeeUsdc");
    const feeEscrow = await hre.viem.deployContract("SiriusEscrow", [feeUsdc.address, ctx.kyb.address]);
    const { hashlock } = teePreimage();
    await feeUsdc.write.mint([ctx.borrower.account.address, ONE_USDC]);
    await feeUsdc.write.approve([feeEscrow.address, ONE_USDC], { account: ctx.borrower.account });

    await expect(
      feeEscrow.write.lock([ctx.provider.account.address, ONE_USDC, hashlock, 7, loanIdHash("fee-token")], {
        account: ctx.borrower.account,
      }),
    ).to.be.rejectedWith("InexactTokenTransfer");
    expect(await feeUsdc.read.balanceOf([feeEscrow.address])).to.equal(0n);
  });

  it("isole les clés des borrowers et permet au runner de vérifier toute la portée", async () => {
    const ctx = await loadFixture(fixture);
    const first = await lockLoan(ctx, { loanId: "same-loan" });
    const second = await lockLoan(ctx, { loanId: "same-loan", borrower: 4 });
    expect(first.loanKey).not.to.equal(second.loanKey);

    expect(await ctx.escrow.read.matchesScope([
      first.loanKey,
      first.borrower.account.address,
      first.provider,
      first.amount,
      first.hashlock,
      30n * 60n,
    ])).to.equal(true);
    expect(await ctx.escrow.read.matchesScope([
      first.loanKey,
      first.borrower.account.address,
      first.provider,
      first.amount + 1n,
      first.hashlock,
      30n * 60n,
    ])).to.equal(false);
  });
});
