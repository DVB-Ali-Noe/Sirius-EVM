/**
 * contracts/scripts/deploy.ts et contracts/scripts/dataset-admin.ts, exécutés TELS QUELS contre un
 * nœud Hardhat local qui annonce le chainId de Robinhood (audit REP-11 à REP-13).
 *
 * Le nœud tourne sur 127.0.0.1, port libre. Sur « mainnet » (4663), l'USDG est simulé par le code
 * de MockUsdc posé à son adresse, et le Safe par une adresse qui porte du code ; il « signe » le lot
 * par usurpation Hardhat (`hardhat_impersonateAccount`). Aucune transaction ne quitte la machine,
 * les clés sont celles, publiques et jetables, du mnémonique de test Hardhat. Les scripts reçoivent
 * un environnement minimal : aucune variable du poste ou du CI ne leur parvient.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import hre from "hardhat";
import {
  createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseEther, toHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET_STABLECOIN_ADDRESS } from "../../src/lib/evm/stablecoin";
import { selectionForModelId, trainingProfileHash } from "../../src/lib/models/registry";
import { SAFE_BATCH_END, SAFE_BATCH_START } from "../scripts/dataset-binding";

const ROOT = resolve(__dirname, "..", "..");
// Comptes 0 à 3 du mnémonique public de test Hardhat (« test test … junk »).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const VERIFIER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const LOCK_AUTHORIZER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const OTHER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const OTHER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
// « Safe » simulé : une adresse qui porte du code, ce que deploy.ts exige d'un admin mainnet.
const SAFE = "0x0000000000000000000000000000000000005afe";
const TREES = trainingProfileHash(selectionForModelId("gradient_boosted_trees"));

const abi = parseAbi([
  "function admin() view returns (address)",
  "function escrow() view returns (address)",
  "function datasets() view returns (address)",
  "function VERSION() view returns (string)",
  "function isSupportedTrainingProfile(bytes32) view returns (bool)",
]);

interface Sim { url: string; client: PublicClient; node: ChildProcess }

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function minimalEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

async function startNode(chainId: 4663 | 46630): Promise<Sim> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const node = spawn(process.execPath, [
    resolve(ROOT, "node_modules/hardhat/internal/cli/cli.js"),
    "--config", resolve(ROOT, "contracts/hardhat.chain-sim.config.js"),
    "node", "--hostname", "127.0.0.1", "--port", String(port),
  ], { cwd: resolve(ROOT, "contracts"), env: minimalEnv({ SIRIUS_SIM_CHAIN_ID: String(chainId) }), stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`nœud Hardhat local non démarré :\n${log}`)), 90_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes("Started HTTP")) { clearTimeout(timer); ready(); }
    };
    node.stdout!.on("data", onData);
    node.stderr!.on("data", onData);
    node.once("exit", () => { clearTimeout(timer); fail(new Error(`nœud Hardhat local arrêté :\n${log}`)); });
  });
  const chain = defineChain({ id: chainId, name: "sim", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const client = createPublicClient({ chain, transport: http(url) }) as PublicClient;
  assert.equal(await client.getChainId(), chainId);
  return { url, client, node };
}

function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: ROOT, env: minimalEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => done({ code, out }));
  });
}

const deploy = (env: Record<string, string>) => run("contracts/scripts/deploy.ts", [], env);
const datasetAdmin = (command: string, env: Record<string, string>) => run("contracts/scripts/dataset-admin.ts", [command], env);

function addressIn(out: string, name: string): Address {
  const found = new RegExp(`^${name}="(0x[0-9a-fA-F]{40})"`, "m").exec(out)?.[1];
  assert.ok(found, `${name} absent de la sortie :\n${out}`);
  return found as Address;
}

function batchIn(out: string): { chainId: string; transactions: { to: Address; value: string; data: Hex }[] } {
  const start = out.indexOf(SAFE_BATCH_START);
  const end = out.indexOf(SAFE_BATCH_END);
  assert.ok(start >= 0 && end > start, `lot Safe absent de la sortie :\n${out}`);
  return JSON.parse(out.slice(start + SAFE_BATCH_START.length, end));
}

const read = (sim: Sim, address: Address, functionName: "admin" | "escrow" | "datasets" | "VERSION") =>
  sim.client.readContract({ address, abi, functionName }) as Promise<string>;
const lower = (value: string) => value.toLowerCase();

describe("deploy.ts sur un nœud local « mainnet » 4663 (REP-11, REP-12, REP-13)", function () {
  let sim: Sim;
  let tokenCode: Hex;

  before(async function () {
    tokenCode = (await hre.artifacts.readArtifact("MockUsdc")).deployedBytecode as Hex;
    sim = await startNode(4663);
    for (const [address, code] of [[MAINNET_STABLECOIN_ADDRESS, tokenCode], [SAFE, "0x00"]] as const) {
      await sim.client.request({ method: "hardhat_setCode" as never, params: [address, code] as never });
    }
  });
  after(() => { sim?.node.kill(); });

  const mainnetEnv = (change: Record<string, string | undefined> = {}): Record<string, string> => {
    const env: Record<string, string | undefined> = {
      SIRIUS_DEPLOY_NETWORK: "mainnet", SIRIUS_ALLOW_MAINNET: "true", SIRIUS_BILLING_VERSION: "7",
      EVM_RPC_URL: sim.url, ROBINHOOD_DEPLOYER_KEY: DEPLOYER_KEY,
      SIRIUS_KYB_ADMIN: SAFE, SIRIUS_KYB_VERIFIER: VERIFIER, SIRIUS_DATASET_ADMIN: SAFE,
      SIRIUS_USDC_ADDRESS: MAINNET_STABLECOIN_ADDRESS, SIRIUS_USDC_CODE_HASH: keccak256(tokenCode),
      SIRIUS_LOCK_AUTHORIZER: LOCK_AUTHORIZER, SIRIUS_DATASET_TRAINING_PROFILES: "gradient_boosted_trees", ...change,
    };
    return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
  };
  const adminEnv = (datasets: Address, escrow: Address, change: Record<string, string> = {}) => ({
    SIRIUS_DEPLOY_NETWORK: "mainnet", EVM_RPC_URL: sim.url, SIRIUS_DATASET_ADDRESS: datasets, SIRIUS_ESCROW_ADDRESS: escrow,
    SIRIUS_DATASET_ADMIN: SAFE, SIRIUS_DATASET_TRAINING_PROFILES: "gradient_boosted_trees", ...change,
  });

  it("refuse, avant toute transaction, un admin absent, égal au déployeur ou sans code", async () => {
    for (const [change, message] of [
      [{ SIRIUS_DATASET_ADMIN: undefined }, /SIRIUS_DATASET_ADMIN \(le Safe de gouvernance\) est obligatoire/],
      [{ SIRIUS_DATASET_ADMIN: DEPLOYER }, /ne peut pas être la clé de déploiement/],
      [{ SIRIUS_DATASET_ADMIN: VERIFIER }, /SIRIUS_KYB_ADMIN/],
      // Un « Safe » qui n'est qu'une clé : refusé on-chain, avant le premier envoi.
      [{ SIRIUS_DATASET_ADMIN: OTHER, SIRIUS_KYB_ADMIN: OTHER }, /doit être un contrat \(Safe\)/],
    ] as const) {
      const result = await deploy(mainnetEnv(change));
      assert.notEqual(result.code, 0, result.out);
      assert.match(result.out, message);
    }
    assert.equal(await sim.client.getTransactionCount({ address: DEPLOYER }), 0);
  });

  it("le registre a le Safe pour admin, rien n'est lié, et le lot Safe lie puis se vérifie", async () => {
    const result = await deploy(mainnetEnv());
    assert.equal(result.code, 0, `deploy.ts a échoué :\n${result.out}`);
    assert.match(result.out, /chainId 4663/);
    assert.match(result.out, /LIAISON EN ATTENTE/);
    const datasets = addressIn(result.out, "SIRIUS_DATASET_ADDRESS");
    const escrow = addressIn(result.out, "SIRIUS_ESCROW_ADDRESS");
    const kyb = addressIn(result.out, "SIRIUS_KYB_ADDRESS");

    // REP-11 corrigé : l'inverse de ce que l'audit avait reproduit.
    assert.equal(await read(sim, datasets, "VERSION"), "sirius-dataset-v5");
    assert.equal(lower(await read(sim, datasets, "admin")), SAFE);
    assert.notEqual(lower(await read(sim, datasets, "admin")), DEPLOYER);
    assert.equal(lower(await read(sim, kyb, "admin")), SAFE);
    // La clé de déploiement n'a rien lié ni ajouté : seulement trois déploiements.
    assert.equal(lower(await read(sim, datasets, "escrow")), `0x${"0".repeat(40)}`);
    assert.equal(lower(await read(sim, escrow, "datasets")), lower(datasets));
    assert.equal(await sim.client.getTransactionCount({ address: DEPLOYER }), 3);
    assert.equal(await sim.client.readContract({ address: datasets, abi, functionName: "isSupportedTrainingProfile", args: [TREES] }), false);

    const batch = batchIn(result.out);
    assert.equal(batch.chainId, "4663");
    assert.equal(batch.transactions.length, 2);
    for (const entry of batch.transactions) {
      assert.equal(lower(entry.to), lower(datasets));
      assert.equal(entry.value, "0");
    }
    assert.ok(batch.transactions[1].data.endsWith(TREES.slice(2)));

    // Avant la signature : verify refuse, prepare-bind redonne exactement le même lot.
    const early = await datasetAdmin("verify", adminEnv(datasets, escrow));
    assert.notEqual(early.code, 0);
    assert.match(early.out, /n'est encore lié à aucun escrow/);
    const prepared = await datasetAdmin("prepare-bind", adminEnv(datasets, escrow));
    assert.equal(prepared.code, 0, prepared.out);
    assert.deepEqual(batchIn(prepared.out).transactions, batch.transactions);

    // REP-12 : un bind vers un mauvais contrat est refusé avant toute signature.
    const second = await deploy(mainnetEnv());
    assert.equal(second.code, 0, second.out);
    const foreignEscrow = addressIn(second.out, "SIRIUS_ESCROW_ADDRESS");
    const wrong = await datasetAdmin("prepare-bind", adminEnv(datasets, foreignEscrow));
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.out, /pointe vers le registre/);
    const notEscrow = await datasetAdmin("prepare-bind", adminEnv(datasets, kyb));
    assert.notEqual(notEscrow.code, 0);
    assert.match(notEscrow.out, /ne répond pas/);
    const wrongAdmin = await datasetAdmin("prepare-bind", adminEnv(datasets, escrow, { SIRIUS_DATASET_ADMIN: DEPLOYER }));
    assert.notEqual(wrongAdmin.code, 0);
    assert.match(wrongAdmin.out, /pas l'admin attendu/);

    // Le Safe exécute le lot (usurpation Hardhat locale, à la place des signatures réelles).
    await sim.client.request({ method: "hardhat_impersonateAccount" as never, params: [SAFE] as never });
    await sim.client.request({ method: "hardhat_setBalance" as never, params: [SAFE, toHex(parseEther("1"))] as never });
    const safeWallet = createWalletClient({ account: SAFE as Address, chain: sim.client.chain, transport: http(sim.url) });
    for (const entry of batch.transactions) {
      const hash = await safeWallet.sendTransaction({ to: entry.to, data: entry.data, value: 0n, chain: sim.client.chain });
      assert.equal((await sim.client.waitForTransactionReceipt({ hash })).status, "success");
    }

    const verified = await datasetAdmin("verify", adminEnv(datasets, escrow));
    assert.equal(verified.code, 0, verified.out);
    assert.match(verified.out, /vérifié/);
    assert.equal(lower(await read(sim, datasets, "escrow")), lower(escrow));
    // Après coup : un second bind est refusé par le script, et la vérification d'un autre escrow échoue.
    const again = await datasetAdmin("prepare-bind", adminEnv(datasets, escrow));
    assert.notEqual(again.code, 0);
    assert.match(again.out, /déjà lié à l'escrow/);
    const otherVerify = await datasetAdmin("verify", adminEnv(datasets, foreignEscrow));
    assert.notEqual(otherVerify.code, 0);
    // Profil déjà présent : rien à signer.
    const profiles = await datasetAdmin("prepare-profiles", adminEnv(datasets, escrow));
    assert.equal(profiles.code, 0, profiles.out);
    assert.match(profiles.out, /rien à signer/);
  });

  it("l'exécution à blanc laisse liaison et profils hors du gas du déployeur", async () => {
    const reference = await deploy(mainnetEnv());
    assert.equal(reference.code, 0, reference.out);
    const before = await sim.client.getTransactionCount({ address: DEPLOYER });
    const dry = await deploy(mainnetEnv({ SIRIUS_DEPLOY_DRY_RUN: "true", SIRIUS_DEPLOY_ESTIMATE_DATASETS: addressIn(reference.out, "SIRIUS_DATASET_ADDRESS") }));
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /Exécution à blanc/);
    assert.doesNotMatch(dry.out, /^\s+bindEscrow\s/m);
    assert.match(dry.out, /payés et signés par 0x0000000000000000000000000000000000005afe/i);
    assert.equal(await sim.client.getTransactionCount({ address: DEPLOYER }), before);
  });
});

describe("deploy.ts sur un nœud local « testnet » 46630", function () {
  let sim: Sim;
  let token: Address;
  let tokenCodeHash: Hex;

  before(async function () {
    sim = await startNode(46630);
    // Jeton à 18 décimales, comme l'USDC du testnet Robinhood, déployé par un compte tiers.
    const { abi: tokenAbi, bytecode } = await hre.artifacts.readArtifact("MockEscrowToken");
    const wallet = createWalletClient({ account: privateKeyToAccount(OTHER_KEY), chain: sim.client.chain, transport: http(sim.url) });
    const hash = await wallet.deployContract({ abi: tokenAbi, bytecode: bytecode as Hex, args: [18], chain: sim.client.chain });
    token = (await sim.client.waitForTransactionReceipt({ hash })).contractAddress as Address;
    tokenCodeHash = keccak256((await sim.client.getBytecode({ address: token }))!);
  });
  after(() => { sim?.node.kill(); });

  it("la clé de déploiement reste admin, explicitement, et lie elle-même après contrôle", async () => {
    const env = {
      SIRIUS_DEPLOY_NETWORK: "testnet", SIRIUS_BILLING_VERSION: "7", SIRIUS_KYB_MODE: "open",
      EVM_RPC_URL: sim.url, ROBINHOOD_DEPLOYER_KEY: DEPLOYER_KEY,
      SIRIUS_USDC_ADDRESS: token, SIRIUS_USDC_CODE_HASH: tokenCodeHash, SIRIUS_LOCK_AUTHORIZER: LOCK_AUTHORIZER,
      SIRIUS_DATASET_TRAINING_PROFILES: "gradient_boosted_trees",
    };
    const result = await deploy(env);
    assert.equal(result.code, 0, `deploy.ts a échoué :\n${result.out}`);
    assert.match(result.out, /admin registre: 0xf39F.*clé de déploiement, choix testnet explicite/i);
    assert.doesNotMatch(result.out, /LIAISON EN ATTENTE/);
    const datasets = addressIn(result.out, "SIRIUS_DATASET_ADDRESS");
    const escrow = addressIn(result.out, "SIRIUS_ESCROW_ADDRESS");
    assert.equal(lower(await read(sim, datasets, "admin")), DEPLOYER);
    assert.equal(lower(await read(sim, datasets, "escrow")), lower(escrow));
    assert.equal(lower(await read(sim, escrow, "datasets")), lower(datasets));
    assert.equal(await sim.client.readContract({ address: datasets, abi, functionName: "isSupportedTrainingProfile", args: [TREES] }), true);

    const verified = await datasetAdmin("verify", {
      SIRIUS_DEPLOY_NETWORK: "testnet", EVM_RPC_URL: sim.url, SIRIUS_DATASET_ADDRESS: datasets, SIRIUS_ESCROW_ADDRESS: escrow,
      SIRIUS_DATASET_ADMIN: DEPLOYER, SIRIUS_DATASET_TRAINING_PROFILES: "gradient_boosted_trees",
    });
    assert.equal(verified.code, 0, verified.out);
  });

  it("refuse un RPC qui n'est pas le réseau demandé", async () => {
    const result = await deploy({
      SIRIUS_DEPLOY_NETWORK: "mainnet", SIRIUS_ALLOW_MAINNET: "true", SIRIUS_BILLING_VERSION: "7", EVM_RPC_URL: sim.url,
      ROBINHOOD_DEPLOYER_KEY: DEPLOYER_KEY, SIRIUS_KYB_ADMIN: SAFE, SIRIUS_KYB_VERIFIER: VERIFIER, SIRIUS_DATASET_ADMIN: SAFE,
      SIRIUS_USDC_ADDRESS: MAINNET_STABLECOIN_ADDRESS, SIRIUS_USDC_CODE_HASH: tokenCodeHash, SIRIUS_LOCK_AUTHORIZER: LOCK_AUTHORIZER,
      SIRIUS_DEPLOY_DRY_RUN: "true",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.out, /Le RPC répond chainId 46630, 4663 attendu/);
  });
});
