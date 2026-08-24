import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS } from "../../src/lib/evm/networks";
import { hashlockOf, loanIdHash, loanKeyFor } from "../../src/lib/evm/loan-key";

const ARTIFACTS = resolve(__dirname, "..", "artifacts", "src");

function abiOf(name: string): Abi {
  return (JSON.parse(readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi }).abi;
}

function required(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} manquante`);
  return value as Hex;
}

function requiredAddress(name: string): `0x${string}` {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} doit être une adresse EVM valide`);
  return value as `0x${string}`;
}

async function main() {
  const chain = EVM_CHAINS.testnet;
  const transport = http(process.env.EVM_RPC_URL || chain.rpcUrls.default.http[0]);
  const account = privateKeyToAccount(required("ROBINHOOD_DEPLOYER_KEY"));
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const escrow = required("NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS");
  const usdc = required("NEXT_PUBLIC_SIRIUS_USDC_ADDRESS");
  const kyb = required("NEXT_PUBLIC_SIRIUS_KYB_ADDRESS");
  const escrowAbi = abiOf("SiriusEscrow");
  const kybAbi = abiOf("SiriusKybRegistry");
  const usdcAbi = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  ] as const;

  const provider = requiredAddress("SIRIUS_SMOKE_PROVIDER_ADDRESS");
  const amount = 2_000_000n;
  const preimage = randomBytes(32);
  const hashlock = hashlockOf(preimage);
  const loanId = `smoke-${randomBytes(6).toString("hex")}`;
  const loanKey = loanKeyFor(account.address, loanId);

  const step = async (label: string, hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, retryCount: 20, retryDelay: 1_500, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${label} rejeté (${hash})`);
    console.log(`✓ ${label} · bloc ${receipt.blockNumber}`);
    return receipt;
  };

  const nativeBalance = await publicClient.getBalance({ address: account.address });
  const [borrowerUsdc, providerUsdcBefore, borrowerKyb, providerKyb, escrowKyb] = await Promise.all([
    publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [account.address] }),
    publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [provider] }),
    publicClient.readContract({ address: kyb, abi: kybAbi, functionName: "isKybValid", args: [account.address] }),
    publicClient.readContract({ address: kyb, abi: kybAbi, functionName: "isKybValid", args: [provider] }),
    publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "kyb" }),
  ]) as [bigint, bigint, boolean, boolean, `0x${string}`];
  if (borrowerUsdc < amount) throw new Error(`USDC insuffisant : ${borrowerUsdc} < ${amount}`);
  if (!borrowerKyb || !providerKyb) throw new Error("Borrower et provider doivent avoir un KYB EVM valide");
  if (escrowKyb.toLowerCase() !== kyb.toLowerCase()) throw new Error("Escrow et registre KYB incohérents");
  console.log(`gas      : ${formatEther(nativeBalance)} ETH`);
  console.log(`USDC     : ${borrowerUsdc}`);

  await step("Approbation USDC", await wallet.writeContract({ address: usdc, abi: usdcAbi, functionName: "approve", args: [escrow, amount], chain, account }));
  await step("Lock USDC", await wallet.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "lock",
    args: [provider, amount, hashlock, 7, loanIdHash(loanId)],
    chain,
    account,
  }));

  const locked = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "getLoan", args: [loanKey] }) as {
    status: number;
    amount: bigint;
    hashlock: Hex;
  };
  if (locked.status !== 1 || locked.amount !== amount || locked.hashlock !== hashlock) {
    throw new Error("Le lock USDC ne correspond pas aux termes attendus");
  }

  await step("Release", await wallet.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "release",
    args: [loanKey, `0x${preimage.toString("hex")}` as Hex],
    chain,
    account,
  }));
  const [revealed, published] = await publicClient.readContract({ address: escrow, abi: escrowAbi, functionName: "preimageOf", args: [loanKey] }) as [boolean, Hex];
  if (!revealed || published.toLowerCase() !== `0x${preimage.toString("hex")}`) throw new Error("Préimage non publié");

  await step("Retrait provider", await wallet.writeContract({ address: escrow, abi: escrowAbi, functionName: "withdrawFor", args: [provider], chain, account }));
  const providerUsdc = await publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [provider] });
  if (providerUsdc !== providerUsdcBefore + amount) throw new Error("Le provider n'a pas reçu les USDC exacts");
  console.log(`fair-exchange USDC validé · hashlock ${createHash("sha256").update(preimage).digest("hex")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
