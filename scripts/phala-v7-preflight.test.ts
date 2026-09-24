import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { keccak256, type PublicClient } from "viem";
import { checkTestnetV7, testnetV7Configuration } from "./phala-v7-preflight";

const saved = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

const address = (n: number) => `0x${String(n).repeat(40)}`;
const environment = () => ({ EVM_NETWORK: "testnet", SIRIUS_BILLING_VERSION: "7", SIRIUS_KYB_MODE: "open",
  SIRIUS_EVM_FINALITY: "finalized", SIRIUS_EVM_CONFIRMATIONS: "1", SIRIUS_USDC_ADDRESS: address(1),
  SIRIUS_DEPLOYER_ADDRESS: address(2), SIRIUS_LOCK_AUTHORIZER: address(3), SIRIUS_COMPUTE_RECIPIENT: address(2),
  SIRIUS_USDC_CODE_HASH: keccak256("0x1234"), SIRIUS_ESCROW_ADDRESS: address(4),
  SIRIUS_DATASET_ADDRESS: address(5), SIRIUS_KYB_ADDRESS: address(6) });

function fixture() {
  Object.assign(process.env, environment());
  const config = testnetV7Configuration(environment());
  const state = { chainId: 46630, runnerWei: BigInt(1), decimals: 18, code: "0x1234", version: "sirius-escrow-usdc-v7",
    authorizer: config.runner, datasetEscrow: config.contracts!.escrow, missingFinality: false, missingHistory: false, reorg: false, stableReads: 0 };
  const readBlocks: bigint[] = [];
  const stableHash = `0x${"12".repeat(32)}`;
  const client = {
    getChainId: async () => state.chainId,
    getBlockNumber: async () => BigInt(100),
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      if (blockTag === "finalized" && state.missingFinality) throw new Error("finalized absent");
      const number = blockNumber ?? BigInt(90);
      if (number === BigInt(90)) state.stableReads++;
      return { number, hash: state.reorg && state.stableReads >= 4 ? `0x${"34".repeat(32)}` : stableHash,
        timestamp: number * BigInt(2) };
    },
    getBytecode: async ({ blockNumber }: { blockNumber: bigint }) => { readBlocks.push(blockNumber); return state.code; },
    getBalance: async ({ address: account, blockNumber }: { address: string; blockNumber: bigint }) => {
      readBlocks.push(blockNumber); return account === config.runner ? state.runnerWei : BigInt(100);
    },
    readContract: async ({ address: contract, functionName, blockNumber }: { address: string; functionName: string; blockNumber: bigint }) => {
      if (state.missingHistory) throw new Error("historical state is not available");
      readBlocks.push(blockNumber);
      if (contract === config.usdc) return functionName === "decimals" ? state.decimals : BigInt(20);
      if (contract === config.contracts!.kyb) return true;
      if (contract === config.contracts!.datasets) return { VERSION: "sirius-dataset-v4", kyb: config.contracts!.kyb, escrow: state.datasetEscrow }[functionName];
      return { VERSION: state.version, lockAuthorizer: state.authorizer, usdc: config.usdc, kyb: config.contracts!.kyb, datasets: config.contracts!.datasets }[functionName];
    },
  } as unknown as PublicClient;
  return { client, config, state, readBlocks };
}

test("le préflight B lit un bloc finalisé cohérent sans confondre contrats valides et activation prête", async () => {
  const { client, config, readBlocks } = fixture();
  const result = await checkTestnetV7(client, config);
  assert.equal(result.chainChecksPassed, true);
  assert.equal(result.activationReady, false);
  assert.equal(result.finalityLagSeconds, "20");
  assert.equal(result.balances.computeRecipient.usdcAtomic, "20");
  assert.ok(readBlocks.length > 10);
  assert.ok(readBlocks.every((number) => number === BigInt(90)));
});

test("le préflight B refuse mainnet, configurations partielles et mélange des rôles", () => {
  for (const change of [{ EVM_NETWORK: "mainnet" }, { SIRIUS_BILLING_VERSION: "6" }, { SIRIUS_KYB_MODE: "strict" },
    { SIRIUS_EVM_FINALITY: "confirmations" }, { SIRIUS_EVM_CONFIRMATIONS: "" }, { SIRIUS_USDC_CODE_HASH: "" },
    { SIRIUS_ESCROW_ADDRESS: "" }, { SIRIUS_LOCK_AUTHORIZER: address(2) }, { SIRIUS_USDC_ADDRESS: address(4) }]) {
    assert.throws(() => testnetV7Configuration({ ...environment(), ...change }));
  }
});

test("le préflight B signale le faucet et les contrats manquants avant activation", async () => {
  const { client, state } = fixture();
  state.runnerWei = BigInt(0);
  const config = testnetV7Configuration({ ...environment(), SIRIUS_ESCROW_ADDRESS: "", SIRIUS_DATASET_ADDRESS: "", SIRIUS_KYB_ADDRESS: "" });
  const report = await checkTestnetV7(client, config);
  assert.equal(report.chainChecksPassed, false);
  assert.deepEqual(report.issues, ["runner.native_balance_zero", "contracts.not_configured"]);
});

test("un RPC du mauvais réseau est refusé avant toute lecture des comptes", async () => {
  const { client, config, state, readBlocks } = fixture();
  state.chainId = 4663;
  await assert.rejects(checkTestnetV7(client, config), /autre réseau/);
  assert.equal(readBlocks.length, 0);
});

test("un bloc finalized disponible sans son état historique ne valide pas le RPC", async () => {
  const { client, config, state } = fixture();
  state.missingHistory = true;
  await assert.rejects(checkTestnetV7(client, config), /historical state/);
});

test("le préflight B bloque un token divergent, un ancien escrow, un autre signataire ou une liaison erronée", async () => {
  for (const change of [{ decimals: 6 }, { code: "0x5678" }, { version: "sirius-escrow-usdc-v6" },
    { authorizer: address(8) }, { datasetEscrow: address(8) }, { missingFinality: true }, { reorg: true }]) {
    const { client, config, state } = fixture();
    Object.assign(state, change);
    await assert.rejects(checkTestnetV7(client, config));
  }
});
