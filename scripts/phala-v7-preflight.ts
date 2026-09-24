import { erc20Abi, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { checkRpcFinality, finalityPolicy } from "../src/lib/evm/finality";
import { siriusescrowv7Abi } from "../src/lib/evm/abi/siriusescrowv7";
import { siriusdatasetregistryAbi } from "../src/lib/evm/abi/siriusdatasetregistry";
import { siriuskybregistryAbi } from "../src/lib/evm/abi/siriuskybregistry";

export function testnetV7Configuration(env: Record<string, string | undefined>) {
  if (env.EVM_NETWORK !== "testnet" || env.SIRIUS_BILLING_VERSION !== "7" || env.SIRIUS_KYB_MODE !== "open"
    || env.SIRIUS_EVM_FINALITY !== "finalized" || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(env.SIRIUS_EVM_CONFIRMATIONS ?? "")) {
    throw new Error("Testnet, v7, KYB ouvert et finalité explicite requis pour le lot B");
  }
  const address = (name: string): Address => {
    const value = env[name]?.trim().toLowerCase();
    if (!value || !/^0x(?!0{40}$)[a-f0-9]{40}$/.test(value)) throw new Error(`Adresse requise : ${name}`);
    return value as Address;
  };
  const usdc = address("SIRIUS_USDC_ADDRESS");
  const deployer = address("SIRIUS_DEPLOYER_ADDRESS");
  const runner = address("SIRIUS_LOCK_AUTHORIZER");
  const computeRecipient = address("SIRIUS_COMPUTE_RECIPIENT");
  if (runner === deployer || runner === computeRecipient) throw new Error("Le compte Phala doit rester distinct de la trésorerie et du déployeur");
  const usdcCodeHash = env.SIRIUS_USDC_CODE_HASH;
  if (!usdcCodeHash || !/^0x[a-f0-9]{64}$/i.test(usdcCodeHash)) throw new Error("Empreinte USDC requise");
  const names = ["SIRIUS_ESCROW_ADDRESS", "SIRIUS_DATASET_ADDRESS", "SIRIUS_KYB_ADDRESS"];
  const configured = names.filter((name) => env[name]?.trim()).length;
  if (configured && configured !== names.length) throw new Error("Configuration partielle des nouveaux contrats");
  const contracts = configured ? { escrow: address(names[0]), datasets: address(names[1]), kyb: address(names[2]) } : null;
  if (contracts && (new Set([usdc, ...Object.values(contracts)]).size !== 4
    || Object.values(contracts).some((value) => [runner, deployer, computeRecipient].includes(value)))) {
    throw new Error("Adresses de contrats et comptes incompatibles");
  }
  return { usdc, usdcCodeHash: usdcCodeHash.toLowerCase() as Hex, deployer, runner, computeRecipient, contracts };
}

export async function checkTestnetV7(client: PublicClient, config: ReturnType<typeof testnetV7Configuration>) {
  if (!finalityPolicy().finalized) throw new Error("Le lot B exige finalized");
  const finality = await checkRpcFinality(client, 46630);
  const blockNumber = BigInt(finality.confirmedBlock);
  const [stable, tip, tokenCode, decimals, deployerWei, runnerWei, computeUsdc] = await Promise.all([
    client.getBlock({ blockNumber }), client.getBlock({ blockNumber: BigInt(finality.latestBlock) }),
    client.getBytecode({ address: config.usdc, blockNumber }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "decimals", blockNumber }),
    client.getBalance({ address: config.deployer, blockNumber }), client.getBalance({ address: config.runner, blockNumber }),
    client.readContract({ address: config.usdc, abi: erc20Abi, functionName: "balanceOf", args: [config.computeRecipient], blockNumber }),
  ]);
  if (!tokenCode || keccak256(tokenCode) !== config.usdcCodeHash || decimals !== 18) throw new Error("Code ou précision USDC testnet inattendu");
  if (stable.hash !== finality.confirmedHash || tip.timestamp < stable.timestamp) throw new Error("Vue RPC incohérente pendant le préflight");
  const issues: string[] = [];
  if (deployerWei === BigInt(0)) issues.push("deployer.native_balance_zero");
  if (runnerWei === BigInt(0)) issues.push("runner.native_balance_zero");
  const contracts = config.contracts;
  if (!contracts) issues.push("contracts.not_configured");
  else {
    const code = await Promise.all(Object.values(contracts).map((address) => client.getBytecode({ address, blockNumber })));
    if (code.some((value) => !value || value === "0x")) throw new Error("Contrat absent du bloc finalisé");
    const escrowRead = { address: contracts.escrow, abi: siriusescrowv7Abi, blockNumber };
    const datasetRead = { address: contracts.datasets, abi: siriusdatasetregistryAbi, blockNumber };
    const [version, authorizer, token, kyb, datasets, datasetVersion, datasetKyb, linkedEscrow, openKyb] = await Promise.all([
      client.readContract({ ...escrowRead, functionName: "VERSION" }),
      client.readContract({ ...escrowRead, functionName: "lockAuthorizer" }),
      client.readContract({ ...escrowRead, functionName: "usdc" }),
      client.readContract({ ...escrowRead, functionName: "kyb" }),
      client.readContract({ ...escrowRead, functionName: "datasets" }),
      client.readContract({ ...datasetRead, functionName: "VERSION" }),
      client.readContract({ ...datasetRead, functionName: "kyb" }),
      client.readContract({ ...datasetRead, functionName: "escrow" }),
      client.readContract({ address: contracts.kyb, abi: siriuskybregistryAbi, functionName: "isKybValid",
        args: ["0x000000000000000000000000000000000000dEaD"], blockNumber }),
    ]);
    if (version !== "sirius-escrow-usdc-v7" || datasetVersion !== "sirius-dataset-v4"
      || authorizer.toLowerCase() !== config.runner || token.toLowerCase() !== config.usdc || kyb.toLowerCase() !== contracts.kyb
      || datasets.toLowerCase() !== contracts.datasets || datasetKyb.toLowerCase() !== contracts.kyb
      || linkedEscrow.toLowerCase() !== contracts.escrow || !openKyb) throw new Error("Versions, liaisons ou KYB des contrats incompatibles avec le lot B");
  }
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash !== stable.hash) throw new Error("Bloc finalisé modifié pendant le préflight");
  return {
    observedAt: new Date().toISOString(), readOnly: true, activationReady: false,
    chainChecksPassed: issues.length === 0, issues, finality,
    finalityLagSeconds: String(tip.timestamp - stable.timestamp),
    balances: { blockNumber: String(blockNumber), deployer: { address: config.deployer, wei: String(deployerWei) },
      runner: { address: config.runner, wei: String(runnerWei) },
      computeRecipient: { address: config.computeRecipient, usdcAtomic: String(computeUsdc) } },
    usdc: { address: config.usdc, decimals, codeHash: config.usdcCodeHash }, contracts,
    remainingProofs: ["gas_estimates_and_funded_limits", "approved_accounting_and_tariffs", "external_stop_supervisor",
      "restored_runner_volumes", "active_hardware_attestation", "application_migration_and_two_wallet_flow"],
  };
}
