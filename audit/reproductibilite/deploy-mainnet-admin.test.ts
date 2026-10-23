/**
 * Audit REP-B : que fait contracts/scripts/deploy.ts quand il croit parler à mainnet ?
 *
 * Le script est lancé SANS MODIFICATION contre un nœud Hardhat local qui annonce le chainId
 * 4663. Le jeton USDG et le Safe sont simulés par du code posé avec `hardhat_setCode`. Aucune
 * transaction ne quitte la machine ; les clés sont celles, publiques et jetables, de Hardhat.
 *
 * Prérequis : `pnpm contracts:compile` (artefacts dans contracts/artifacts).
 * Lancer : node --import tsx --test audit/reproductibilite/deploy-mainnet-admin.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, defineChain, http, keccak256, parseAbi, type Hex } from "viem";
import { MAINNET_STABLECOIN_ADDRESS } from "../../src/lib/evm/stablecoin";

const ROOT = resolve(__dirname, "..", "..");
const PORT = 8599;
const LOCAL = `http://127.0.0.1:${PORT}`;
// Comptes 0, 1 et 2 du mnémonique public de test Hardhat (« test test … junk »).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const VERIFIER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const LOCK_AUTHORIZER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
// « Safe » simulé : une adresse avec du code (STOP), ce que deploy.ts exige de l'admin KYB.
const SAFE = "0x0000000000000000000000000000000000005afe";
// Jeton simulé : code d'exécution de contracts/src/test/MockUsdc.sol (6 décimales, comme l'USDG).
const TOKEN_CODE = (JSON.parse(readFileSync(
  resolve(ROOT, "contracts/artifacts/src/test/MockUsdc.sol/MockUsdc.json"), "utf8")) as { deployedBytecode: Hex }).deployedBytecode;

const chain = defineChain({
  id: 4663, name: "mainnet-sim", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL] } },
});
const client = createPublicClient({ chain, transport: http(LOCAL) });
let node: ChildProcess | undefined;

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => done({ code, out }));
  });
}

before(async () => {
  assert.ok(existsSync(resolve(ROOT, "contracts/artifacts/src/SiriusDatasetRegistry.sol/SiriusDatasetRegistry.json")),
    "lancer d'abord pnpm contracts:compile");
  node = spawn(process.execPath, [
    resolve(ROOT, "node_modules/hardhat/internal/cli/cli.js"),
    "--config", resolve(__dirname, "hardhat.mainnet-sim.config.js"),
    "node", "--hostname", "127.0.0.1", "--port", String(PORT),
  ], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("nœud Hardhat local non démarré")), 60_000);
    node!.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Started HTTP")) { clearTimeout(timer); ready(); }
    });
    node!.on("exit", () => fail(new Error("nœud Hardhat local arrêté")));
  });
  assert.equal(await client.getChainId(), 4663);
  for (const [address, code] of [[MAINNET_STABLECOIN_ADDRESS, TOKEN_CODE], [SAFE, "0x00"]] as const) {
    await client.request({ method: "hardhat_setCode" as never, params: [address, code] as never });
  }
});

after(() => { node?.kill(); });

test("REP-11 : sur mainnet, deploy.ts installe la clé de déploiement comme admin immuable du registre v5", async () => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP,
    SIRIUS_DEPLOY_NETWORK: "mainnet",
    SIRIUS_ALLOW_MAINNET: "true",
    SIRIUS_BILLING_VERSION: "7",
    EVM_RPC_URL: LOCAL,
    ROBINHOOD_DEPLOYER_KEY: DEPLOYER_KEY,
    SIRIUS_KYB_ADMIN: SAFE,
    SIRIUS_KYB_VERIFIER: VERIFIER,
    SIRIUS_USDC_ADDRESS: MAINNET_STABLECOIN_ADDRESS,
    SIRIUS_USDC_CODE_HASH: keccak256(TOKEN_CODE),
    SIRIUS_LOCK_AUTHORIZER: LOCK_AUTHORIZER,
  };
  const result = await run(process.execPath, ["--import", "tsx", "contracts/scripts/deploy.ts"], env);
  assert.equal(result.code, 0, `deploy.ts a échoué :\n${result.out}`);
  assert.match(result.out, /chainId 4663/);
  const datasets = /SIRIUS_DATASET_ADDRESS="(0x[0-9a-fA-F]{40})"/.exec(result.out)?.[1] as Hex | undefined;
  assert.ok(datasets, "adresse du registre absente de la sortie");
  const kyb = /SIRIUS_KYB_ADDRESS="(0x[0-9a-fA-F]{40})"/.exec(result.out)?.[1] as Hex;

  const abi = parseAbi(["function admin() view returns (address)", "function VERSION() view returns (string)"]);
  const [registryAdmin, version, kybAdmin] = await Promise.all([
    client.readContract({ address: datasets, abi, functionName: "admin" }),
    client.readContract({ address: datasets, abi, functionName: "VERSION" }),
    client.readContract({ address: kyb, abi, functionName: "admin" }),
  ]);
  assert.equal(version, "sirius-dataset-v5");
  // Le KYB est bien gouverné par le Safe…
  assert.equal(kybAdmin.toLowerCase(), SAFE);
  // …mais le registre v5 l'est par la clé de déploiement, sans aucun moyen de le corriger.
  assert.equal(registryAdmin.toLowerCase(), DEPLOYER);
  assert.notEqual(registryAdmin.toLowerCase(), SAFE);
});
