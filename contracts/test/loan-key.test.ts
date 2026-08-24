import { expect } from "chai";
import { createHash, randomBytes } from "node:crypto";
import hre from "hardhat";
import type { Hex } from "viem";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { hashlockOf, loanKeyFor } from "../../src/lib/evm/loan-key";

/**
 * Croise les dérivations TypeScript de l'application avec celles du contrat.
 *
 * C'est le test qui empêche la classe de bug la plus coûteuse du portage : une
 * clé calculée différemment des deux côtés produirait des règlements adressés à
 * des prêts inexistants, sans qu'aucun des deux camps ne paraisse fautif.
 */
async function fixture() {
  const escrow = await hre.viem.deployContract("SiriusEscrow");
  const wallets = await hre.viem.getWalletClients();
  return { escrow, wallets };
}

describe("Dérivations partagées application ↔ contrat", () => {
  it("loanKeyFor reproduit exactement loanKeyOf on-chain", async () => {
    const { escrow, wallets } = await loadFixture(fixture);

    for (const wallet of wallets.slice(0, 3)) {
      for (const loanId of [
        "clx1a2b3c4d5e6f7g8h9i0j1k",
        "loan-avec-tirets",
        "a",
        "identifiant_très_long_".repeat(4),
        "0x1234",
      ]) {
        const offChain = loanKeyFor(wallet.account.address, loanId);
        const onChain = await escrow.read.loanKeyOfId([wallet.account.address, loanId]);
        expect(offChain).to.equal(onChain, `divergence pour ${wallet.account.address} / ${loanId}`);
      }
    }
  });

  it("loanKeyFor est insensible à la casse de l'adresse", async () => {
    const { wallets } = await loadFixture(fixture);
    const address = wallets[0].account.address;

    // La base stocke en minuscules, le wallet renvoie la forme EIP-55 : les deux
    // doivent produire la même clé, sinon un prêt devient inaccessible.
    expect(loanKeyFor(address.toLowerCase(), "loan-1")).to.equal(loanKeyFor(address, "loan-1"));
  });

  it("hashlockOf reproduit le hashlock recalculé par le contrat", async () => {
    const { escrow, wallets } = await loadFixture(fixture);
    const [borrower, provider] = wallets;

    const preimage = randomBytes(32);
    const hashlock = hashlockOf(preimage);

    await escrow.write.lock([provider.account.address, hashlock, 7, "loan-hash"], {
      account: borrower.account,
      value: 10n ** 17n,
    });

    const loanKey = loanKeyFor(borrower.account.address, "loan-hash");
    // Le contrat accepte le préimage : il a donc recalculé le même hashlock.
    await escrow.write.release([loanKey, `0x${preimage.toString("hex")}` as Hex], {
      account: provider.account,
    });

    const [revealed] = await escrow.read.preimageOf([loanKey]);
    expect(revealed).to.equal(true);
  });

  it("hashlockOf refuse un préimage qui n'a pas 32 octets", () => {
    for (const size of [0, 16, 31, 33, 64]) {
      expect(() => hashlockOf(randomBytes(size))).to.throw("32 octets");
    }
  });

  it("le hashlock reste du SHA-256, jamais du keccak256", async () => {
    const { escrow } = await loadFixture(fixture);
    const preimage = randomBytes(32);

    // Garde explicite : basculer sur keccak256 casserait la dérivation du TEE.
    expect(hashlockOf(preimage)).to.equal(
      `0x${createHash("sha256").update(preimage).digest("hex")}`,
    );
    expect(await escrow.read.VERSION()).to.equal("sirius-escrow-v1");
  });
});
