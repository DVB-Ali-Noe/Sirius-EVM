/**
 * Parcours Sirius complet avec les arbres boostés, sur une chaîne Hardhat locale lancée par ce test.
 *
 * LIMITE : l'enclave Intel TDX est SIMULÉE (TEE_MODE=stub, runner appelé en processus). Ce test
 * prouve la logique (contrats, paiements, modèle, livraison chiffrée), pas l'attestation matérielle.
 *
 * Aucun réseau réel : toute requête qui ne vise ni le nœud local, ni l'IPFS simulé, ni le runner
 * simulé est refusée et comptée. Seul le téléchargement des données publiques OpenML 42477
 * (Taïwan) a lieu avant l'installation de ce garde-fou, avec repli sur credit-risk.csv.
 *
 * Wallets : tous générés à la volée (clés aléatoires jetables), financés en ETH local par
 * `hardhat_setBalance` et en stablecoin de test par `mint`. Aucune clé existante n'est lue.
 *
 * Commande : sh audit/parcours/run.sh  (compile les contrats puis lance ce fichier).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeFunctionData, getAddress, http,
  keccak256, parseEventLogs, toHex, type Abi, type Address, type Hex, type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { DatasetRef } from "@/lib/tee/contract";
import type { BudgetPolicy } from "@/lib/runner/budget-ledger";
import type { SignedComputeQuote } from "@/lib/billing/quote";
import type { GradientBoostedTreesModel } from "@/lib/models/registry";
import { firstRows, loadAuditDataset } from "./datasets";

const GBDT = { modelId: "gradient_boosted_trees", modelVersion: "1.0.0" } as const;
const ORIGIN = "http://localhost:3000";
const IPFS = "https://ipfs.test.invalid";

type Party = "acheteur" | "acheteur2" | "fournisseur" | "attaquant" | "tresorerie";
const PARTIES: Party[] = ["acheteur", "acheteur2", "fournisseur", "attaquant", "tresorerie"];

test("parcours arbres boostés de bout en bout sur EVM locale (TDX simulé)", { timeout: 900_000 }, async (t) => {
  const startedAt = performance.now();
  const savedEnv = { ...process.env };
  const fetchOriginal = globalThis.fetch;

  // ---------------------------------------------------------------- données publiques
  const data = await loadAuditDataset(fetchOriginal);
  console.log(`[parcours] données : ${data.source}, ${data.rows} lignes, ${data.csv.length} octets`);
  assert.ok(data.rows >= 10_000, "le profil arbres exige 10 000 lignes");

  // ---------------------------------------------------------------- environnement isolé
  const reportFile = process.env.SIRIUS_AUDIT_REPORT_FILE ?? join(tmpdir(), "sirius-parcours-mesures.json");
  for (const key of Object.keys(process.env)) {
    if (/^(SIRIUS_|EVM_|RUNNER_|PINATA_|NEXT_PUBLIC_|ROBINHOOD_|DATABASE_|PHALA_|DSTACK_|TEE_)/.test(key)) delete process.env[key];
  }
  const temporary = mkdtempSync(join(tmpdir(), "sirius-parcours-"));
  const portServer = createServer().listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((done) => portServer.close(() => done()));
  const nodeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ROBINHOOD_/.test(key))) as NodeJS.ProcessEnv;
  const node = spawn(process.execPath, [resolve("node_modules/hardhat/internal/cli/cli.js"), "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: resolve("contracts"), env: { ...nodeEnv, SIRIUS_LOCAL_BILLING_TEST: "true", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  node.stderr.resume();
  t.after(async () => {
    globalThis.fetch = fetchOriginal;
    node.kill("SIGTERM");
    if (node.exitCode === null) await once(node, "exit");
    rmSync(temporary, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("EVM locale non démarrée")), 30_000);
    node.once("exit", () => { clearTimeout(timer); reject(new Error("EVM locale interrompue")); });
    node.stdout.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Started HTTP")) { clearTimeout(timer); done(); } });
  });
  const rpc = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "stub", SIRIUS_BILLING_VERSION: "7",
    EVM_RPC_URL: rpc, SIRIUS_APP_ORIGIN: ORIGIN,
    // Clé maîtresse jetable : la clé de règlement du runner en dérive, elle aussi jetable.
    SIRIUS_MASTER_KEY: randomBytes(32).toString("base64"),
    PINATA_JWT: "synthetic", PINATA_GATEWAY: IPFS,
    RUNNER_BUDGET_FILE: join(temporary, "budget.sqlite"), RUNNER_BILLING_POLICY_FILE: join(temporary, "tariff.json"),
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/unused",
    NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS: GBDT.modelId,
  });
  const treesOn = () => { process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = GBDT.modelId; };
  const treesOff = () => { process.env.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = ""; };

  const { robinhoodTestnet: chain } = await import("@/lib/evm/networks");
  const contractsBackup = chain.contracts;
  chain.contracts = undefined;
  t.after(() => { chain.contracts = contractsBackup; });
  const client = createPublicClient({ chain, transport: http(rpc) });
  assert.equal(await client.getChainId(), 46630, "Hardhat local imite l'identifiant du testnet Robinhood");

  async function localRpc(method: string, params: unknown[]) {
    const response = await fetchOriginal(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json() as { result?: unknown; error?: unknown };
    assert.equal(body.error, undefined);
    return body.result;
  }

  // ---------------------------------------------------------------- wallets jetables
  const accounts = {
    admin: privateKeyToAccount(generatePrivateKey()),
    fournisseur: privateKeyToAccount(generatePrivateKey()),
    acheteur: privateKeyToAccount(generatePrivateKey()),
    attaquant: privateKeyToAccount(generatePrivateKey()),
    acheteur2: privateKeyToAccount(generatePrivateKey()),
    tresorerie: privateKeyToAccount(generatePrivateKey()),
  };
  const runner = (await import("@/lib/evm/runner-account")).settlementAccount();
  process.env.SIRIUS_LOCK_AUTHORIZER = runner.address.toLowerCase();
  const roleOf = new Map<string, string>([[runner.address.toLowerCase(), "runner (TEE simulé)"]]);
  for (const [name, account] of Object.entries(accounts)) roleOf.set(account.address.toLowerCase(), name);
  const ETH = BigInt(10) ** BigInt(18);
  for (const address of [...Object.values(accounts).map((a) => a.address), runner.address]) {
    await localRpc("hardhat_setBalance", [address, toHex(ETH * BigInt(10))]);
  }
  const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(rpc) });

  // ---------------------------------------------------------------- contrats et outils
  function artifact(name: string) {
    return JSON.parse(readFileSync(resolve(`contracts/artifacts/src/${name}.sol/${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
  }
  const abi = {
    usdc: artifact("SiriusTestUsdc").abi, kyb: artifact("SiriusKybRegistry").abi,
    registry: artifact("SiriusDatasetRegistry").abi, escrow: artifact("SiriusEscrowV7").abi,
  };
  const txLabels = new Map<string, { label: string; step: string }>();
  let step = "préparation";
  async function mark(label: string) { step = label; }
  async function confirm(hash: Hex, label: string): Promise<TransactionReceipt> {
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", label);
    txLabels.set(hash.toLowerCase(), { label, step });
    return receipt;
  }
  async function deploy(name: string, args: unknown[] = []) {
    const hash = await walletOf(accounts.admin).deployContract({ ...artifact(name), args });
    return getAddress((await confirm(hash, `déploiement ${name}`)).contractAddress!);
  }
  interface Call { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }
  async function send(label: string, account: PrivateKeyAccount, call: Call) {
    const hash = await walletOf(account).writeContract({ ...call, args: call.args ?? [] } as never);
    return confirm(hash, label);
  }
  function revertName(error: unknown): string | undefined {
    if (!(error instanceof BaseError)) return undefined;
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName ?? reverted.reason : undefined;
  }
  const rejected: { label: string; error: string }[] = [];
  /** Le contrat refuse : vérifié par simulation (eth_call au dernier bloc), aucun état modifié. */
  async function expectRevert(label: string, account: PrivateKeyAccount, call: Call, errorName: string) {
    let caught: unknown;
    try { await client.simulateContract({ account, ...call, args: call.args ?? [] } as never); } catch (error) { caught = error; }
    assert.ok(caught, `${label} aurait dû être refusé`);
    assert.equal(revertName(caught), errorName, `${label} : ${String(caught).slice(0, 300)}`);
    rejected.push({ label, error: errorName });
  }
  async function expectRunnerError(label: string, action: Promise<unknown>, pattern: RegExp) {
    await assert.rejects(action, pattern, label);
    rejected.push({ label, error: pattern.source });
  }
  function read<T>(address: Address, contractAbi: Abi, functionName: string, args: readonly unknown[] = []) {
    return client.readContract({ address, abi: contractAbi, functionName, args } as never) as Promise<T>;
  }
  async function events(address: Address, contractAbi: Abi, eventName: string, receipt: TransactionReceipt) {
    return parseEventLogs({ abi: contractAbi, logs: receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()), eventName } as never) as unknown as { args: Record<string, unknown> }[];
  }

  // ================================================================ 1. déploiement
  await mark("1. déploiement");
  const usdc = await deploy("SiriusTestUsdc");
  const kyb = await deploy("SiriusKybRegistry", [accounts.admin.address, accounts.admin.address]);
  const registry = await deploy("SiriusDatasetRegistry", [kyb, accounts.admin.address]);
  const escrow = await deploy("SiriusEscrowV7", [usdc, kyb, registry, runner.address]);
  const bound = await send("admin : bindEscrow", accounts.admin, { address: registry, abi: abi.registry, functionName: "bindEscrow", args: [escrow] });
  assert.equal((await events(registry, abi.registry, "EscrowBound", bound))[0].args.escrow, escrow);
  assert.equal(await read(registry, abi.registry, "VERSION"), "sirius-dataset-v5");
  assert.equal(await read(escrow, abi.escrow, "VERSION"), "sirius-escrow-usdc-v7");
  assert.equal(await read(escrow, abi.escrow, "lockAuthorizer"), runner.address);
  Object.assign(process.env, { SIRIUS_ESCROW_ADDRESS: escrow, SIRIUS_USDC_ADDRESS: usdc, SIRIUS_KYB_ADDRESS: kyb, SIRIUS_DATASET_ADDRESS: registry });
  await expectRevert("attaquant : rebrancher l'escrow du registre", accounts.attaquant,
    { address: registry, abi: abi.registry, functionName: "bindEscrow", args: [usdc] }, "NotAdmin");

  // ================================================================ 2. wallets financés, KYB
  await mark("2. financement et KYB");
  const unit = BigInt(10) ** BigInt(18); // le stablecoin de test a 18 décimales, comme celui du testnet
  const usd = (value: number) => (BigInt(Math.round(value * 1_000_000)) * unit) / BigInt(1_000_000);
  const minted: Record<Party, bigint> = { acheteur: usd(100), acheteur2: usd(100), attaquant: usd(100), fournisseur: BigInt(0), tresorerie: BigInt(0) };
  for (const party of PARTIES) {
    if (minted[party] > BigInt(0)) await send(`mint ${party}`, accounts.admin, { address: usdc, abi: abi.usdc, functionName: "mint", args: [accounts[party].address, minted[party]] });
  }
  async function grantKyb(name: keyof typeof accounts) {
    const subject = accounts[name];
    const now = (await client.getBlock()).timestamp;
    const expiresAt = Number(now) + 365 * 86_400;
    const nonce = await read<bigint>(kyb, abi.kyb, "nonces", [subject.address]);
    const digest = await read<Hex>(kyb, abi.kyb, "attestationDigest", [subject.address, accounts.admin.address, expiresAt, nonce]);
    const signature = await accounts.admin.sign({ hash: digest });
    const receipt = await send(`KYB ${name}`, subject, { address: kyb, abi: abi.kyb, functionName: "acceptAttestation", args: [accounts.admin.address, expiresAt, signature] });
    assert.equal((await events(kyb, abi.kyb, "KybAttested", receipt))[0].args.subject, subject.address);
    assert.equal(await read(kyb, abi.kyb, "isKybValid", [subject.address]), true);
  }
  for (const name of ["fournisseur", "acheteur", "acheteur2"] as const) await grantKyb(name);
  assert.equal(await read(kyb, abi.kyb, "isKybValid", [accounts.attaquant.address]), false);

  // Soldes attendus, tenus à l'unité près et comparés à la chaîne à chaque étape.
  const expected = {
    usdc: { ...minted, escrow: BigInt(0) } as Record<Party | "escrow", bigint>,
    credit: Object.fromEntries(PARTIES.map((party) => [party, BigInt(0)])) as Record<Party, bigint>,
    locked: BigInt(0),
  };
  const snapshots: { step: string; values: Record<string, string> }[] = [];
  async function checkBalances(label: string) {
    const values: Record<string, string> = {};
    for (const party of PARTIES) {
      const balance = await read<bigint>(usdc, abi.usdc, "balanceOf", [accounts[party].address]);
      const credit = await read<bigint>(escrow, abi.escrow, "creditOf", [accounts[party].address]);
      assert.equal(balance, expected.usdc[party], `${label} : solde USDC ${party}`);
      assert.equal(credit, expected.credit[party], `${label} : crédit escrow ${party}`);
      values[party] = `${balance}`;
      values[`crédit ${party}`] = `${credit}`;
    }
    const escrowBalance = await read<bigint>(usdc, abi.usdc, "balanceOf", [escrow]);
    assert.equal(escrowBalance, expected.usdc.escrow, `${label} : solde USDC escrow`);
    const [locked, owed, balance] = await read<readonly [bigint, bigint, bigint, bigint]>(escrow, abi.escrow, "accounting");
    assert.equal(locked, expected.locked, `${label} : USDC verrouillés`);
    assert.equal(owed, Object.values(expected.credit).reduce((a, b) => a + b, BigInt(0)), `${label} : crédits dus`);
    assert.equal(balance, locked + owed, `${label} : l'escrow détient exactement verrouillé + dû`);
    values.escrow = `${escrowBalance}`;
    snapshots.push({ step: label, values });
  }
  const onLock = (party: Party, total: bigint) => { expected.usdc[party] -= total; expected.usdc.escrow += total; expected.locked += total; };
  const onRelease = (datasetAmount: bigint, computeAmount: bigint) => {
    expected.locked -= datasetAmount + computeAmount; expected.credit.fournisseur += datasetAmount; expected.credit.tresorerie += computeAmount;
  };
  const onRefund = (party: Party, total: bigint, fee: bigint) => {
    expected.locked -= total; expected.credit[party] += total - fee; expected.credit.tresorerie += fee;
  };
  const onWithdraw = (party: Party) => { expected.usdc[party] += expected.credit[party]; expected.usdc.escrow -= expected.credit[party]; expected.credit[party] = BigInt(0); };
  await checkBalances("après financement");

  // ---------------------------------------------------------------- runner local (TEE simulé)
  const { initializeBudgetLedger } = await import("@/lib/runner/budget-ledger");
  const policy: BudgetPolicy = {
    version: 1, chainId: chain.id, wallet: runner.address.toLowerCase(), accountingReference: "audit-local-uniquement",
    validUntil: Date.now() + 4 * 86_400_000, earnedMarginUsdMicros: "100000000000", cashUsdMicros: "100000000000", fixedReserveUsdMicros: "1000000",
    costsUsdMicros: { request: "1", seal: "50", training: "1000" }, maxFailures: 10, maxActive: 64,
    gas: { totalWei: String(ETH * BigInt(3)), maxTransactionWei: String(ETH / BigInt(100)), maxGas: "2000000", maxFeePerGasWei: "10000000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 1 },
  };
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE!, policy);
  const PRICE = usd(5);
  const tariff = (withTrees: boolean) => {
    const linear = { computeAmount: String(usd(2)), maxFailureFee: String(usd(0.1)), executionRateAtomicPerMs: String(usd(0.0001)), maxExecutionMs: 10_000 };
    const trees = { computeAmount: String(usd(2)), maxFailureFee: String(usd(0.5)), executionRateAtomicPerMs: String(usd(0.00001)), maxExecutionMs: 30_000 };
    writeFileSync(process.env.RUNNER_BILLING_POLICY_FILE!, JSON.stringify({
      version: 1, tariffVersion: "audit-local-v1", costReference: "non-commercial", validUntil: policy.validUntil,
      chainId: chain.id, usdc: usdc.toLowerCase(), usdcDecimals: 18, computeRecipient: accounts.tresorerie.address.toLowerCase(),
      minimumComputeAmount: String(usd(1)),
      profiles: { linear_regression: linear, logistic_regression: linear, ...(withTrees ? { gradient_boosted_trees: trees } : {}) },
    }), { mode: 0o600 });
  };
  tariff(true);

  // IPFS simulé en mémoire ; toute autre destination que le nœud local est refusée.
  const blobs = new Map<string, Buffer>();
  let uploads = 0;
  let reads = 0;
  const externalCalls: string[] = [];
  const { handleRunnerOp } = await import("@/runner/handler");
  const { datasetIngressPublicKey } = await import("@/lib/tee/ingress");
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === rpc || url === `${rpc}/`) return fetchOriginal(input, init);
    if (url === "https://uploads.pinata.cloud/v3/files") {
      const file = (init!.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const cid = `bafy-audit-${++uploads}`;
      blobs.set(cid, bytes);
      return Response.json({ data: { cid, size: bytes.length } });
    }
    if (url.startsWith(`${IPFS}/ipfs/`)) {
      reads++;
      const blob = blobs.get(url.split("/").at(-1)!);
      return blob ? new Response(new Uint8Array(blob)) : new Response("absent", { status: 404 });
    }
    externalCalls.push(new URL(url).host);
    throw new Error(`réseau externe interdit pendant l'audit : ${new URL(url).host}`);
  };

  const { sealDataset } = await import("@/lib/tee/core");
  const { escrowLock } = await import("@/lib/tee/core");
  const { issueDatasetReceipt } = await import("@/lib/runner/receipt");
  const { datasetIdHash, cidHash } = await import("@/lib/evm/dataset-key");
  const { trainingProfileHash, parseDeliveredModel } = await import("@/lib/models/registry");
  const { gbdtScore, binaryAuc, isHeldOut, sigmoid, GBDT_TOO_FEW_ROWS_MESSAGE } = await import("@/lib/models/gbdt");
  const { loanKeyFor } = await import("@/lib/evm/loan-key");
  const { quoteLockTerms, totalQuoteAmount, computeQuoteHash, executionReceiptTypedData } = await import("@/lib/billing/quote");
  const { readLoan } = await import("@/lib/evm/escrow");
  const { runnerBudget } = await import("@/lib/runner/budget");
  const { createRunnerDelivery } = await import("@/lib/runner/delivery-client");
  const { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } = await import("@/lib/runner/authorization-client");
  const { buildDelegationMessage } = await import("@/lib/runner/authorization-contract");
  const { useWalletStore } = await import("@/stores/wallet");
  const { encryptDatasetForRunner } = await import("@/lib/tee/ingress-client");
  const { requireCurrentEvmDeployment } = await import("@/lib/evm/deployment");
  const { decryptModelPayload } = await import("@/lib/train/model-client");
  const { resolveCertificate, certificateExport } = await import("@/lib/certificate/resolve");
  const { verifyCertificate } = await import("@/lib/certificate/verification");
  const { verifyAttestation, parseLoanAttestationPayload } = await import("@/lib/tee/attestation");

  /** Session runner signée par le wallet (même message que la page de connexion). */
  async function delegate(account: PrivateKeyAccount) {
    useWalletStore.getState().setConnected(account.address, "testnet", "external");
    const sessionPublicKey = await beginRunnerDelegation();
    const message = buildDelegationMessage({ origin: ORIGIN, address: account.address, sessionPublicKey, network: "testnet", issuedAt: Date.now(), expiresAt: Date.now() + 30 * 60_000, challengeToken: "audit.challenge" });
    await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
  }
  const borrowed = (addr: Address) => addr.toLowerCase();

  // ================================================================ 3. profil arbres on-chain
  await mark("3. profil arbres");
  const treesProfile = trainingProfileHash(GBDT);
  assert.equal(treesProfile, keccak256(toHex("sirius.training-profile.v1:gradient_boosted_trees:1.0.0")));
  await assert.rejects(requireCurrentEvmDeployment(), /profil d’entraînement proposé n’est pas accepté/, "flag allumé sans profil on-chain : déploiement refusé");
  await expectRevert("attaquant : addTrainingProfile", accounts.attaquant,
    { address: registry, abi: abi.registry, functionName: "addTrainingProfile", args: [treesProfile] }, "NotAdmin");
  await expectRevert("fournisseur : mint arbres avant ajout du profil", accounts.fournisseur,
    { address: registry, abi: abi.registry, functionName: "mint", args: [keccak256(toHex("x")), keccak256(toHex("y")), keccak256(toHex("z")), BigInt(1), treesProfile] }, "InvalidTrainingProfile");
  const added = await send("admin : addTrainingProfile(arbres)", accounts.admin, { address: registry, abi: abi.registry, functionName: "addTrainingProfile", args: [treesProfile] });
  const addedEvents = await events(registry, abi.registry, "TrainingProfileAdded", added);
  assert.equal(addedEvents.length, 1);
  assert.equal(addedEvents[0].args.profile, treesProfile);
  assert.equal(await read(registry, abi.registry, "isSupportedTrainingProfile", [treesProfile]), true);
  const again = await send("admin : addTrainingProfile répété", accounts.admin, { address: registry, abi: abi.registry, functionName: "addTrainingProfile", args: [treesProfile] });
  assert.equal((await events(registry, abi.registry, "TrainingProfileAdded", again)).length, 0, "ajout idempotent, sans nouvel événement");
  await requireCurrentEvmDeployment();

  // ================================================================ 4. publication du fournisseur
  await mark("4. publication");
  async function sealThroughRunner(datasetId: string, csv: Buffer, model: { modelId: string; modelVersion: string } = GBDT) {
    await delegate(accounts.fournisseur);
    const content = csv.buffer.slice(csv.byteOffset, csv.byteOffset + csv.byteLength) as ArrayBuffer;
    const envelope = await encryptDatasetForRunner(content, datasetId, datasetIngressPublicKey());
    const authorization = await issueRunnerGrant("seal-dataset", { datasetId },
      [datasetId, String(PRICE), "1", String(csv.length), envelope.ciphertext, model.modelId, model.modelVersion]);
    return handleRunnerOp("seal-dataset", { datasetId, priceUsdcAtomic: String(PRICE), challengeDays: 1, sizeBytes: csv.length, envelope, ...model, authorization }) as Promise<{
      cid: string; wrappedKey: string; merkleRoot: string; sizeBytes: number; metrics: { rowCount: number; columnCount: number }; runnerReceipt: string;
    }>;
  }
  // Moins de 10 000 lignes : refus propre à l'ingestion, rien n'est épinglé ni publié.
  const before = uploads;
  await expectRunnerError("ingestion arbres de 9 999 lignes", sealThroughRunner("taiwan-9999", firstRows(data, 9_999)), new RegExp(GBDT_TOO_FEW_ROWS_MESSAGE));
  treesOff();
  await expectRunnerError("ingestion arbres, flag coupé", sealThroughRunner("taiwan-flag-off", data.csv), /Modèle ou version non autorisé/);
  treesOn();
  assert.equal(uploads, before, "aucun blob épinglé pour un dépôt refusé");

  const sealed = await sealThroughRunner("taiwan-gbdt", data.csv);
  assert.equal(sealed.metrics.rowCount, data.rows);
  assert.equal(sealed.sizeBytes, data.csv.length);
  const stored = blobs.get(sealed.cid)!.toString("utf8");
  assert.ok(!stored.includes(data.header.slice(0, 3).join(",")), "le blob IPFS ne contient pas le CSV en clair");
  assert.ok(!stored.includes(data.csv.toString("utf8").split("\n")[1]), "aucune ligne en clair dans le blob");
  const dataset: DatasetRef = { datasetId: "taiwan-gbdt", cid: sealed.cid, wrappedKey: sealed.wrappedKey, merkleRoot: sealed.merkleRoot,
    priceUsdcAtomic: String(PRICE), challengeDays: 1, ...GBDT };
  const datasetReceipt = sealed.runnerReceipt;
  async function mint(ref: DatasetRef, sizeBytes: number, label: string) {
    const receipt = await send(label, accounts.fournisseur, { address: registry, abi: abi.registry, functionName: "mint",
      args: [datasetIdHash(ref.datasetId), cidHash(ref.cid), `0x${ref.merkleRoot}`, BigInt(sizeBytes), trainingProfileHash(ref)] });
    const [minted] = await events(registry, abi.registry, "DatasetMinted", receipt);
    assert.equal(minted.args.provider, accounts.fournisseur.address);
    assert.equal(minted.args.trainingProfile, trainingProfileHash(ref));
    assert.equal(minted.args.cidHash, cidHash(ref.cid));
    assert.equal(minted.args.merkleRoot, `0x${ref.merkleRoot}`);
    assert.equal(minted.args.sizeBytes, BigInt(sizeBytes));
    return minted.args.datasetId as Hex;
  }
  const onChainDatasetId = await mint(dataset, sealed.sizeBytes, "fournisseur : mint Taïwan (arbres)");
  assert.equal(await read(registry, abi.registry, "isLiveForProviderAndProfile", [onChainDatasetId, accounts.fournisseur.address, treesProfile]), true);
  await expectRevert("fournisseur : mint du même dataset une 2e fois", accounts.fournisseur, { address: registry, abi: abi.registry, functionName: "mint",
    args: [datasetIdHash(dataset.datasetId), cidHash(dataset.cid), `0x${dataset.merkleRoot}`, BigInt(sealed.sizeBytes), treesProfile] }, "DatasetExists");
  await expectRevert("attaquant : mint sans KYB", accounts.attaquant, { address: registry, abi: abi.registry, functionName: "mint",
    args: [datasetIdHash("pirate"), cidHash(dataset.cid), `0x${dataset.merkleRoot}`, BigInt(1), treesProfile] }, "KybRequired");
  await checkBalances("après publication");

  // ---------------------------------------------------------------- outils acheteur
  const deadline = () => Math.floor(Date.now() / 1000) + 300;
  async function prepare(buyer: PrivateKeyAccount, loanId: string, ref = dataset, receipt = datasetReceipt) {
    const result = await handleRunnerOp("prepare-escrow-lock", { ...ref, datasetReceipt: receipt, loanId, borrower: buyer.address, authorizationDeadline: deadline() }) as { billingQuote: SignedComputeQuote };
    return result.billingQuote;
  }
  interface Locked { signed: SignedComputeQuote; loanKey: Hex; lockBlock: bigint; total: bigint; party: Party; buyer: PrivateKeyAccount }
  async function lock(party: Party, signed: SignedComputeQuote, label: string): Promise<Locked> {
    const buyer = accounts[party];
    const total = BigInt(totalQuoteAmount(signed.quote));
    await send(`${label} : approve`, buyer, { address: usdc, abi: abi.usdc, functionName: "approve", args: [escrow, total] });
    const receipt = await send(`${label} : lock`, buyer, { address: escrow, abi: abi.escrow, functionName: "lock", args: [quoteLockTerms(signed.quote), signed.authorization] });
    const loanKey = loanKeyFor(buyer.address, signed.quote.loanId);
    const [locked] = await events(escrow, abi.escrow, "LoanLocked", receipt);
    assert.equal(locked.args.loanKey, loanKey);
    assert.equal(locked.args.borrower, buyer.address);
    assert.equal(locked.args.provider, accounts.fournisseur.address);
    assert.equal(locked.args.computeRecipient, accounts.tresorerie.address);
    assert.equal(locked.args.datasetAmount, BigInt(signed.quote.datasetAmount));
    assert.equal(locked.args.computeAmount, BigInt(signed.quote.computeAmount));
    assert.equal(locked.args.maxFailureFee, BigInt(signed.quote.maxFailureFee));
    const transfers = parseEventLogs({ abi: abi.usdc, logs: receipt.logs, eventName: "Transfer" } as never) as unknown as { args: { from: Address; to: Address; value: bigint } }[];
    assert.deepEqual(transfers.map((e) => [e.args.from, e.args.to, e.args.value]), [[buyer.address, escrow, total]]);
    onLock(party, total);
    const loan = await readLoan(loanKey);
    assert.equal(loan?.status, 1, "prêt verrouillé (Locked)");
    return { signed, loanKey, lockBlock: receipt.blockNumber, total, party, buyer };
  }
  const deliveryFor = (buyer: PrivateKeyAccount, loanId: string) => createRunnerDelivery(`loan:${buyer.address.toLowerCase()}:${loanId}`);
  type RunResult = { modelCid: string; metrics: Record<string, number>; runnerReceipt: string; releaseEnvelopeHash: string; releaseEnvelope?: unknown;
    attestation: { signer: string; payloadHash: string; signature: string; payload: string; evidence: unknown } };
  async function runGrant(buyer: PrivateKeyAccount, loanId: string, deliveryPublicKey: string, ref = dataset, receipt = datasetReceipt) {
    await delegate(buyer);
    return issueRunnerGrant("run-loan-job", { loanId, datasetId: ref.datasetId }, [loanId, ref.datasetId, receipt, deliveryPublicKey, ref.modelId, ref.modelVersion]);
  }
  function run(loan: Locked, deliveryPublicKey: string, authorization: unknown, ref = dataset, receipt = datasetReceipt) {
    return handleRunnerOp("run-loan-job", { ...ref, loanId: loan.signed.quote.loanId, datasetReceipt: receipt, deliveryPublicKey, authorization, billingQuote: loan.signed }) as Promise<RunResult>;
  }
  function settle(loan: Locked, result: RunResult) {
    return handleRunnerOp("settle-loan", { loanId: loan.signed.quote.loanId, loanReceipt: result.runnerReceipt,
      releaseEnvelopeHash: result.releaseEnvelopeHash, lockBlock: String(loan.lockBlock) }) as Promise<{ settleTxHash: Hex }>;
  }
  async function modelKey(account: PrivateKeyAccount, loanId: string, result: RunResult, deliveryPublicKey: string, settleTxHash: string) {
    await delegate(account);
    const authorization = await issueRunnerGrant("loan-model-key", { loanId }, [loanId, result.runnerReceipt, deliveryPublicKey]);
    return handleRunnerOp("loan-model-key", { loanId, loanReceipt: result.runnerReceipt, deliveryPublicKey, authorization, settleTxHash }) as Promise<{ modelCid: string; modelKeyEnvelope: never }>;
  }
  async function receiptOf(hash: Hex, label: string) {
    const receipt = await client.getTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    txLabels.set(hash.toLowerCase(), { label, step });
    return receipt;
  }
  async function withdraw(party: Party, label: string, caller: PrivateKeyAccount = accounts[party]) {
    const amount = expected.credit[party];
    const receipt = await send(label, caller, { address: escrow, abi: abi.escrow, functionName: "withdrawFor", args: [accounts[party].address] });
    const [withdrawn] = await events(escrow, abi.escrow, "Withdrawn", receipt);
    assert.equal(withdrawn.args.account, accounts[party].address);
    assert.equal(withdrawn.args.amount, amount);
    onWithdraw(party);
  }

  // ================================================================ 5. parcours nominal
  await mark("5. parcours nominal");
  await delegate(accounts.acheteur);
  const quote = await prepare(accounts.acheteur, "nominal");
  assert.equal(quote.quote.modelId, GBDT.modelId);
  assert.equal(quote.quote.datasetAmount, String(PRICE));
  assert.equal(quote.quote.computeAmount, String(usd(2)), "tarif compute du profil arbres");
  assert.equal(quote.quote.maxFailureFee, String(usd(0.5)));
  assert.equal(quote.quote.maxExecutionMs, 30_000);
  assert.equal(quote.quote.computeRecipient, accounts.tresorerie.address.toLowerCase());
  assert.equal(quote.quote.onChainDatasetId, onChainDatasetId);
  // Le devis est idempotent : le même prêt redemandé rend le même devis signé.
  assert.equal(computeQuoteHash((await prepare(accounts.acheteur, "nominal")).quote), computeQuoteHash(quote.quote));
  await checkBalances("devis signé, rien débité");

  const nominal = await lock("acheteur", quote, "acheteur : nominal");
  assert.equal(nominal.total, usd(7));
  assert.equal(await read(escrow, abi.escrow, "activeLoansForDataset", [onChainDatasetId]), BigInt(1));
  await checkBalances("après lock nominal");
  await expectRevert("fournisseur : détruire le dataset pendant un prêt", accounts.fournisseur,
    { address: registry, abi: abi.registry, functionName: "destroy", args: [datasetIdHash(dataset.datasetId)] }, "DatasetInUse");
  await expectRevert("attaquant : détruire le dataset du fournisseur", accounts.attaquant,
    { address: registry, abi: abi.registry, functionName: "destroy", args: [datasetIdHash(dataset.datasetId)] }, "UnknownDataset");

  const delivery = await deliveryFor(accounts.acheteur, "nominal");
  const readsBeforeRun = reads;
  const grant = await runGrant(accounts.acheteur, "nominal", delivery.publicKey);
  const trainStarted = performance.now();
  const result = await run(nominal, delivery.publicKey, grant);
  const trainingMs = Math.round(performance.now() - trainStarted);
  assert.equal(reads, readsBeforeRun + 1, "le dataset est lu une fois, dans le runner");
  assert.equal(result.releaseEnvelope, undefined, "aucune capsule de modèle avant le règlement v7");
  assert.ok(result.modelCid && blobs.has(result.modelCid));
  console.log(`[parcours] entraînement arbres (${data.rows} lignes) : ${trainingMs} ms, métriques visibles côté Next :`, result.metrics);
  await expectRunnerError("rejeu du grant run-loan-job", run(nominal, delivery.publicKey, grant), /Grant runner déjà utilisé/);
  await checkBalances("après entraînement, avant règlement (fonds toujours verrouillés)");

  // Avant règlement : pas de clé de modèle, même pour l'acheteur.
  await expectRunnerError("clé du modèle avant règlement", modelKey(accounts.acheteur, "nominal", result, delivery.publicKey, `0x${"00".repeat(32)}`), /confirmé|introuvable|invalide/i);
  // Reçu d'exécution forgé par l'attaquant : refusé, la retenue reste nulle.
  const forged = { consumedCompute: usd(0.5), evidenceHash: keccak256(toHex("faux")), observedAt: Number((await client.getBlock()).timestamp), finalFailure: true };
  const forgedSignature = await accounts.attaquant.signTypedData(executionReceiptTypedData(nominal.signed.quote, nominal.loanKey, forged) as never);
  await expectRevert("attaquant : reçu d'exécution forgé", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "recordExecution", args: [nominal.loanKey, forged, forgedSignature] }, "InvalidExecutionReceipt");
  await expectRevert("attaquant : release avec un faux préimage", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "release", args: [nominal.loanKey, keccak256(toHex("devine"))] }, "InvalidPreimage");
  await expectRevert("attaquant : refund avant l'échéance", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "refund", args: [nominal.loanKey] }, "ChallengePeriodActive");

  const settled = await settle(nominal, result);
  const settleReceipt = await receiptOf(settled.settleTxHash, "runner : release nominal");
  assert.equal(settleReceipt.from.toLowerCase(), runner.address.toLowerCase());
  const [released] = await events(escrow, abi.escrow, "LoanReleased", settleReceipt);
  assert.equal(released.args.datasetAmount, PRICE);
  assert.equal(released.args.computeAmount, usd(2));
  const [revealed] = await events(escrow, abi.escrow, "PreimageRevealed", settleReceipt);
  assert.equal(revealed.args.hashlock, nominal.signed.quote.hashlock);
  const accrued = await events(escrow, abi.escrow, "CreditAccrued", settleReceipt);
  assert.deepEqual(accrued.map((e) => [e.args.account, e.args.amount]), [[accounts.fournisseur.address, PRICE], [accounts.tresorerie.address, usd(2)]]);
  onRelease(PRICE, usd(2));
  assert.equal((await readLoan(nominal.loanKey))?.status, 2, "prêt libéré (Released)");
  await checkBalances("après règlement nominal");
  const nonce = await client.getTransactionCount({ address: runner.address });
  assert.deepEqual(await settle(nominal, result), settled, "régler deux fois rend le même hash");
  assert.equal(await client.getTransactionCount({ address: runner.address }), nonce, "aucune nouvelle transaction");
  const preimage = revealed.args.preimage as Hex;
  await expectRevert("attaquant : release une 2e fois avec le préimage public", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "release", args: [nominal.loanKey, preimage] }, "LoanNotLocked");
  await expectRevert("attaquant : refund d'un prêt réglé", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "refund", args: [nominal.loanKey] }, "LoanNotLocked");
  await checkBalances("après tentatives de double règlement");

  // Livraison : seule la clé de livraison de l'acheteur ouvre le modèle.
  const delivered = await modelKey(accounts.acheteur, "nominal", result, delivery.publicKey, settled.settleTxHash);
  assert.equal(delivered.modelCid, result.modelCid);
  const key = await delivery.decrypt(delivered.modelKeyEnvelope);
  const model = parseDeliveredModel(await decryptModelPayload(JSON.parse(blobs.get(result.modelCid)!.toString("utf8")), key)) as GradientBoostedTreesModel;
  assert.equal(model.algo, "gradient_boosted_trees");
  assert.equal(model.target, data.header.at(-1));
  assert.deepEqual(model.features, data.header.slice(0, -1));
  assert.equal(model.trees.length, 150);
  assert.equal(model.metrics.n, data.rows);
  const attackerDelivery = await deliveryFor(accounts.attaquant, "nominal");
  await assert.rejects(attackerDelivery.decrypt(delivered.modelKeyEnvelope), "une autre clé de livraison n'ouvre pas l'enveloppe");
  await assert.rejects(decryptModelPayload(JSON.parse(blobs.get(result.modelCid)!.toString("utf8")), randomBytes(32).toString("base64")), "une autre clé n'ouvre pas le modèle");
  await expectRunnerError("attaquant : clé du modèle de l'acheteur", modelKey(accounts.attaquant, "nominal", result, attackerDelivery.publicKey, settled.settleTxHash), /réservée au borrower/);
  rejected.push({ label: "attaquant : déchiffrer l'enveloppe de l'acheteur avec sa propre clé", error: "AES-GCM" });

  // Métriques : recalculées par l'acheteur sur la part tenue à l'écart (1 ligne sur 5).
  const lines = data.csv.toString("utf8").trim().split(/\r?\n/).slice(1).map((line) => line.split(",").map(Number));
  const heldOut = lines.filter((_, row) => isHeldOut(row));
  const scores = heldOut.map((row) => gbdtScore(model.baseScore, model.trees, row.slice(0, -1)));
  const labels = heldOut.map((row) => row.at(-1)!);
  const auc = binaryAuc(scores, labels)!;
  const accuracy = scores.filter((score, i) => (sigmoid(score) >= 0.5 ? 1 : 0) === labels[i]).length / scores.length;
  console.log(`[parcours] métriques livrées :`, model.metrics, `AUC recalculée ${auc.toFixed(4)}, accuracy recalculée ${accuracy.toFixed(4)}`);
  assert.ok(Math.abs(auc - model.metrics.heldOutAuc) < 0.005, "AUC held-out recalculée = AUC livrée");
  assert.ok(Math.abs(accuracy - model.metrics.heldOutAccuracy) < 0.005, "accuracy held-out recalculée = livrée");
  if (data.source.startsWith("OpenML")) {
    assert.ok(model.metrics.heldOutAuc > 0.74 && model.metrics.heldOutAuc < 0.82, "AUC Taïwan plausible (référence 0,787)");
    assert.ok(model.metrics.heldOutAccuracy > 0.77, "accuracy au-dessus de la classe majoritaire (≈ 0,78)");
  } else assert.ok(model.metrics.heldOutAuc > 0.6);
  assert.ok(model.metrics.trainAuc >= model.metrics.heldOutAuc - 0.02, "pas de signe de fuite inverse");

  // Certificat : attestation logicielle (HMAC) cohérente avec la chaîne ; quote TDX absente en local.
  assert.equal(verifyAttestation(result.attestation), true);
  assert.equal(verifyAttestation({ ...result.attestation, payloadHash: "0".repeat(64) }), false);
  assert.equal(result.attestation.evidence, null, "pas de quote TDX : enclave simulée");
  const payload = parseLoanAttestationPayload(result.attestation.payload);
  assert.equal(payload.version, 2);
  assert.equal(payload.loanKey, nominal.loanKey);
  assert.equal(payload.billingQuoteHash, computeQuoteHash(nominal.signed.quote));
  const certificate = resolveCertificate({
    id: "nominal", status: "SETTLED", datasetId: dataset.datasetId, borrower: borrowed(accounts.acheteur.address), provider: borrowed(accounts.fournisseur.address),
    amountUsdcAtomic: String(nominal.total), billingQuoteHash: computeQuoteHash(nominal.signed.quote), modelId: GBDT.modelId, modelVersion: GBDT.modelVersion,
    modelCid: result.modelCid, evmLoanKey: nominal.loanKey, evmChainId: chain.id, evmEscrowAddress: escrow.toLowerCase(),
    attestationHash: result.attestation.payloadHash, attestationPayload: result.attestation.payload, attestationQuote: null, attestationEventLog: null,
    attestationComposeHash: null, settleTxHash: settled.settleTxHash, settledAt: new Date(),
    dataset: { id: dataset.datasetId, name: "Taïwan", status: "LISTED", evmDatasetId: onChainDatasetId, ipfsCid: dataset.cid, challengeDays: 1, merkleRoot: dataset.merkleRoot },
  }, () => ({ chainId: chain.id, escrow: escrow.toLowerCase() }));
  assert.equal(certificate.kind, "ready", "certificat produit");
  if (certificate.kind === "ready") {
    assert.equal(certificate.record.settlement.network, "testnet");
    assert.equal(certificateExport(certificate.record).attestation.tdxQuote, null);
    assert.deepEqual(await verifyCertificate(certificate.record), { status: "absent" }, "vérification matérielle impossible en local");
  }

  await withdraw("fournisseur", "fournisseur : retrait");
  await withdraw("tresorerie", "trésorerie : retrait (payé par l'admin)", accounts.admin);
  await expectRevert("attaquant : retrait sans crédit", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "withdraw" }, "NothingToWithdraw");
  await checkBalances("après retraits du fournisseur et de la trésorerie");

  // ================================================================ 6. chemins d'échec
  await mark("6a. CSV invalide");
  // Dataset scellé hors du contrôle d'ingestion (simulation d'un fichier corrompu) : cible hors 0/1.
  const corruptedLines = data.csv.toString("utf8").trim().split(/\r?\n/);
  corruptedLines[1] = corruptedLines[1].replace(/,[01]$/, ",2");
  async function directSeal(datasetId: string, csv: Buffer) {
    const sealedDirect = await sealDataset(datasetId, csv);
    const ref: DatasetRef = { datasetId, cid: sealedDirect.cid, wrappedKey: sealedDirect.wrappedKey, merkleRoot: sealedDirect.merkleRoot,
      priceUsdcAtomic: String(PRICE), challengeDays: 1, ...GBDT };
    await mint(ref, sealedDirect.sizeBytes, `fournisseur : mint ${datasetId}`);
    return { ref, receipt: issueDatasetReceipt(accounts.fournisseur.address.toLowerCase(), ref) };
  }
  async function failedRun(party: Party, loanId: string, csv: Buffer, label: string) {
    const { ref, receipt } = await directSeal(loanId, csv);
    await delegate(accounts[party]);
    const locked = await lock(party, await prepare(accounts[party], loanId, ref, receipt), label);
    const failureDelivery = await deliveryFor(accounts[party], loanId);
    const failureGrant = await runGrant(accounts[party], loanId, failureDelivery.publicKey, ref, receipt);
    await expectRunnerError(`${label} : entraînement`, run(locked, failureDelivery.publicKey, failureGrant, ref, receipt), /Calcul échoué : remboursement crédité/);
    const loan = await readLoan(locked.loanKey);
    assert.equal(loan?.status, 4, "prêt en échec (Failed)");
    const fee = BigInt(loan!.billing!.consumedCompute);
    assert.ok(fee <= BigInt(locked.signed.quote.maxFailureFee), "retenue bornée par le devis");
    const [failure] = await client.getContractEvents({ address: escrow, abi: abi.escrow, eventName: "LoanFailed", args: { loanKey: locked.loanKey }, fromBlock: locked.lockBlock } as never) as unknown as { args: { refundAmount: bigint; retainedFee: bigint }; transactionHash: Hex }[];
    assert.equal(failure.args.refundAmount, locked.total - fee);
    assert.equal(failure.args.retainedFee, fee);
    await receiptOf(failure.transactionHash, `runner : recordExecution échec (${label})`);
    onRefund(party, locked.total, fee);
    await checkBalances(`${label} : remboursé immédiatement, retenue ${fee}`);
    return fee;
  }
  const invalidFee = await failedRun("acheteur", "csv-invalide", Buffer.from(`${corruptedLines.join("\n")}\n`), "CSV invalide");
  await mark("6b. moins de 10 000 lignes à l'entraînement");
  const smallFee = await failedRun("acheteur2", "moins-10000", firstRows(data, 9_999), "9 999 lignes scellées hors ingestion");

  await mark("6c. flag arbres coupé");
  treesOff();
  await delegate(accounts.acheteur);
  const budgetBefore = runnerBudget()!.snapshot().allocatedWei;
  await expectRunnerError("devis arbres, flag coupé", prepare(accounts.acheteur, "flag-coupe-avant"), /Modèle ou version non autorisé/);
  assert.equal(runnerBudget()!.snapshot().allocatedWei, budgetBefore, "aucune réservation pour un devis refusé");
  await checkBalances("flag coupé avant devis : rien débité");
  treesOn();
  const flagLoan = await lock("acheteur", await prepare(accounts.acheteur, "flag-coupe-apres"), "flag coupé après lock");
  const flagDelivery = await deliveryFor(accounts.acheteur, "flag-coupe-apres");
  const flagGrant = await runGrant(accounts.acheteur, "flag-coupe-apres", flagDelivery.publicKey);
  treesOff();
  const readsBeforeFlag = reads;
  await expectRunnerError("entraînement arbres, flag coupé après lock", run(flagLoan, flagDelivery.publicKey, flagGrant), /Modèle ou version non autorisé/);
  assert.equal(reads, readsBeforeFlag, "dataset jamais déchiffré");
  assert.equal((await readLoan(flagLoan.loanKey))?.status, 1, "fonds restés verrouillés jusqu'à l'échéance");
  treesOn();
  tariff(false);
  // Sans tarif arbres : la publication et le mint passent, mais aucun devis n'est possible.
  const untariffed = await sealThroughRunner("taiwan-sans-tarif", firstRows(data, 10_000));
  const untariffedRef: DatasetRef = { datasetId: "taiwan-sans-tarif", cid: untariffed.cid, wrappedKey: untariffed.wrappedKey,
    merkleRoot: untariffed.merkleRoot, priceUsdcAtomic: String(PRICE), challengeDays: 1, ...GBDT };
  await mint(untariffedRef, untariffed.sizeBytes, "fournisseur : mint arbres sans tarif runner");
  await expectRunnerError("devis arbres sans tarif", prepare(accounts.acheteur, "sans-tarif", untariffedRef, untariffed.runnerReceipt), /Tarif compute absent/);
  tariff(true);
  await checkBalances("flag coupé après lock : fonds verrouillés");

  // ================================================================ 7. attaquant
  await mark("7. attaquant");
  await delegate(accounts.attaquant);
  await expectRunnerError("fournisseur : emprunter son propre dataset", prepare(accounts.fournisseur, "auto"), /propre dataset/);
  await expectRunnerError("attaquant : profil inconnu au runner", handleRunnerOp("prepare-escrow-lock", { ...dataset, modelId: "random_forest", datasetReceipt, loanId: "rf", borrower: accounts.attaquant.address, authorizationDeadline: deadline() }), /Modèle ou version non autorisé/);
  await expectRunnerError("attaquant : profil logistique sur un titre arbres", handleRunnerOp("prepare-escrow-lock", { ...dataset, modelId: "logistic_regression", datasetReceipt, loanId: "lr", borrower: accounts.attaquant.address, authorizationDeadline: deadline() }), /reçu|Reçu|receipt|hors scope|invalide/i);
  const attackerQuote = await prepare(accounts.attaquant, "attaque");
  const attackerTerms = quoteLockTerms(attackerQuote.quote);
  await send("attaquant : approve", accounts.attaquant, { address: usdc, abi: abi.usdc, functionName: "approve", args: [escrow, BigInt(totalQuoteAmount(attackerQuote.quote))] });
  // Le runner signe un devis sans lire le KYB (c'est Next qui le contrôle) ; le contrat refuse le lock.
  await expectRevert("attaquant : lock sans KYB", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "lock", args: [attackerTerms, attackerQuote.authorization] }, "KybRequired");
  await grantKyb("attaquant");
  for (const [profile, name] of [[trainingProfileHash({ modelId: "logistic_regression", modelVersion: "1.0.0" }), "logistique"], [keccak256(toHex("profil-inexistant")), "inexistant"]] as const) {
    await expectRevert(`attaquant : lock sur un profil ${name}`, accounts.attaquant,
      { address: escrow, abi: abi.escrow, functionName: "lock", args: [{ ...attackerTerms, trainingProfile: profile }, attackerQuote.authorization] }, "InvalidDataset");
  }
  await expectRevert("attaquant : montant compute réduit sous la même autorisation", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "lock", args: [{ ...attackerTerms, computeAmount: usd(1) }, attackerQuote.authorization] }, "InvalidLockAuthorization");
  await expectRevert("attaquant : rejouer l'autorisation de l'acheteur", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "lock", args: [quoteLockTerms(flagLoan.signed.quote), flagLoan.signed.authorization] }, "InvalidLockAuthorization");
  await expectRevert("acheteur : rejouer sa propre autorisation déjà utilisée", accounts.acheteur,
    { address: escrow, abi: abi.escrow, functionName: "lock", args: [quoteLockTerms(flagLoan.signed.quote), flagLoan.signed.authorization] }, "LoanExists");
  await expectRevert("attaquant : autorisation signée par lui-même", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "lock", args: [attackerTerms, { deadline: attackerQuote.authorization.deadline, signature: await accounts.attaquant.signTypedData({
      domain: { name: "SiriusEscrow", version: "7", chainId: chain.id, verifyingContract: escrow },
      types: { LockAuthorization: [{ name: "termsHash", type: "bytes32" }, { name: "deadline", type: "uint40" }] },
      primaryType: "LockAuthorization", message: { termsHash: keccak256(toHex("x")), deadline: attackerQuote.authorization.deadline } }) }] }, "InvalidLockAuthorization");
  const attackerGrant = await runGrant(accounts.attaquant, flagLoan.signed.quote.loanId, attackerDelivery.publicKey);
  await expectRunnerError("attaquant : lancer le calcul du prêt de l'acheteur", run(flagLoan, attackerDelivery.publicKey, attackerGrant), /hors scope/);
  await checkBalances("après tentatives de l'attaquant");

  // ================================================================ 8. deux acheteurs en même temps
  await mark("8. deux acheteurs simultanés");
  const [quoteA, quoteB] = await Promise.all([prepare(accounts.acheteur, "simultane-a"), prepare(accounts.acheteur2, "simultane-b")]);
  const [loanA, loanB] = await Promise.all([lock("acheteur", quoteA, "acheteur : simultané"), lock("acheteur2", quoteB, "acheteur2 : simultané")]);
  assert.equal(await read(escrow, abi.escrow, "activeLoansForDataset", [onChainDatasetId]), BigInt(3), "flag-coupé + deux prêts simultanés");
  const [deliveryA, deliveryB] = await Promise.all([deliveryFor(accounts.acheteur, "simultane-a"), deliveryFor(accounts.acheteur2, "simultane-b")]);
  const grantA = await runGrant(accounts.acheteur, "simultane-a", deliveryA.publicKey);
  const grantB = await runGrant(accounts.acheteur2, "simultane-b", deliveryB.publicKey);
  const parallelStarted = performance.now();
  const [resultA, resultB] = await Promise.all([run(loanA, deliveryA.publicKey, grantA), run(loanB, deliveryB.publicKey, grantB)]);
  const parallelMs = Math.round(performance.now() - parallelStarted);
  const settlements = await Promise.allSettled([settle(loanA, resultA), settle(loanB, resultB)]);
  const concurrentSettleErrors = settlements.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason?.message ?? s));
  if (concurrentSettleErrors.length) console.log("[parcours] règlements simultanés refusés puis rejoués :", concurrentSettleErrors);
  const settledA = settlements[0].status === "fulfilled" ? settlements[0].value : await settle(loanA, resultA);
  const settledB = settlements[1].status === "fulfilled" ? settlements[1].value : await settle(loanB, resultB);
  await receiptOf(settledA.settleTxHash, "runner : release simultané A");
  await receiptOf(settledB.settleTxHash, "runner : release simultané B");
  onRelease(PRICE, usd(2));
  onRelease(PRICE, usd(2));
  await checkBalances("après deux règlements simultanés");
  const keyA = await deliveryA.decrypt((await modelKey(accounts.acheteur, "simultane-a", resultA, deliveryA.publicKey, settledA.settleTxHash)).modelKeyEnvelope);
  const keyB = await deliveryB.decrypt((await modelKey(accounts.acheteur2, "simultane-b", resultB, deliveryB.publicKey, settledB.settleTxHash)).modelKeyEnvelope);
  const blobA = JSON.parse(blobs.get(resultA.modelCid)!.toString("utf8"));
  const blobB = JSON.parse(blobs.get(resultB.modelCid)!.toString("utf8"));
  const modelA = await decryptModelPayload(blobA, keyA);
  const modelB = await decryptModelPayload(blobB, keyB);
  assert.deepEqual(modelA, model, "même fichier, même modèle (déterministe)");
  assert.deepEqual(modelB, model);
  assert.notEqual(keyA, keyB, "une clé de modèle par prêt");
  await assert.rejects(decryptModelPayload(blobB, keyA), "l'acheteur A n'ouvre pas le modèle de B");
  await assert.rejects(deliveryA.decrypt((await modelKey(accounts.acheteur2, "simultane-b", resultB, deliveryB.publicKey, settledB.settleTxHash)).modelKeyEnvelope));

  // ================================================================ 9. plafonds de la bêta (Next, prepareLoan)
  await mark("9. plafonds bêta");
  const caps = await capsScenario();
  await checkBalances("après plafonds bêta");

  // ================================================================ 10. échéance
  await mark("10. échéance et remboursements");
  await localRpc("evm_increaseTime", [86_401]);
  await localRpc("evm_mine", []);
  const flagPreimage = escrowLock("flag-coupe-apres", accounts.acheteur.address.toLowerCase()).preimage as Hex;
  await expectRevert("release après l'échéance, même avec le bon préimage", accounts.attaquant,
    { address: escrow, abi: abi.escrow, functionName: "release", args: [flagLoan.loanKey, flagPreimage] }, "ChallengePeriodElapsed");
  if (caps.unlocked) {
    await expectRevert("acheteur2 : lock avec une autorisation expirée", accounts.acheteur2,
      { address: escrow, abi: abi.escrow, functionName: "lock", args: [quoteLockTerms(caps.unlocked.quote), caps.unlocked.authorization] }, "LockAuthorizationExpired");
  }
  const attackerBefore = await read<bigint>(usdc, abi.usdc, "balanceOf", [accounts.attaquant.address]);
  // L'attaquant déclenche le remboursement du prêt de l'acheteur : l'argent va à l'acheteur.
  for (const loan of [flagLoan, ...caps.locked]) {
    const receipt = await send(`attaquant : refund du prêt ${loan.signed.quote.loanId} d'un autre`, accounts.attaquant, { address: escrow, abi: abi.escrow, functionName: "refund", args: [loan.loanKey] });
    const [refunded] = await events(escrow, abi.escrow, "LoanRefunded", receipt);
    assert.equal(refunded.args.borrower, loan.buyer.address);
    assert.equal(refunded.args.refundAmount, loan.total, "remboursement intégral sans exécution");
    assert.equal(refunded.args.retainedFee, BigInt(0));
    assert.equal((await readLoan(loan.loanKey))?.status, 3, "prêt remboursé (Refunded)");
    onRefund(loan.party, loan.total, BigInt(0));
  }
  assert.equal(await read(usdc, abi.usdc, "balanceOf", [accounts.attaquant.address]), attackerBefore);
  await checkBalances("après remboursements à l'échéance (attaquant : 0 gagné)");
  await expectRevert("attaquant : retirer le crédit de l'acheteur", accounts.attaquant, { address: escrow, abi: abi.escrow, functionName: "withdraw" }, "NothingToWithdraw");
  await withdraw("acheteur", "attaquant : withdrawFor(acheteur), fonds vers l'acheteur", accounts.attaquant);
  await withdraw("acheteur2", "acheteur2 : retrait");
  await withdraw("fournisseur", "fournisseur : retrait final");
  await withdraw("tresorerie", "trésorerie : retrait final", accounts.admin);
  await checkBalances("fin : escrow vide");
  assert.equal(expected.usdc.escrow, BigInt(0));
  const supply = await read<bigint>(usdc, abi.usdc, "totalSupply");
  assert.equal(PARTIES.reduce((sum, party) => sum + expected.usdc[party], BigInt(0)), supply, "aucun USDC créé ni perdu");
  assert.equal(expected.usdc.fournisseur, PRICE * BigInt(3), "fournisseur payé pour les trois entraînements réussis, rien pour les échecs");
  assert.equal(expected.usdc.tresorerie, usd(2) * BigInt(3) + invalidFee + smallFee);
  assert.deepEqual(externalCalls, [], "aucun appel réseau externe");

  // ================================================================ 11. mesures
  const totalMs = Math.round(performance.now() - startedAt);
  const latest = await client.getBlockNumber();
  const gasRows: { étape: string; libellé: string; de: string; fonction: string; gas: string; coûtWei: string }[] = [];
  const decoders = new Map<string, [string, Abi]>([[escrow.toLowerCase(), ["Escrow", abi.escrow]], [registry.toLowerCase(), ["Registre", abi.registry]],
    [kyb.toLowerCase(), ["KYB", abi.kyb]], [usdc.toLowerCase(), ["USDC", abi.usdc]]]);
  for (let number = BigInt(1); number <= latest; number++) {
    const block = await client.getBlock({ blockNumber: number, includeTransactions: true });
    for (const tx of block.transactions) {
      const receipt = await client.getTransactionReceipt({ hash: tx.hash });
      const decoder = tx.to ? decoders.get(tx.to.toLowerCase()) : undefined;
      const fn = decoder ? `${decoder[0]}.${decodeFunctionData({ abi: decoder[1], data: tx.input }).functionName}` : "déploiement";
      const known = txLabels.get(tx.hash.toLowerCase());
      gasRows.push({ étape: known?.step ?? "?", libellé: known?.label ?? "(non étiquetée)", de: roleOf.get(tx.from.toLowerCase()) ?? tx.from,
        fonction: fn, gas: receipt.gasUsed.toString(), coûtWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() });
    }
  }
  const gasByFunction = new Map<string, bigint[]>();
  for (const row of gasRows) gasByFunction.set(row.fonction, [...(gasByFunction.get(row.fonction) ?? []), BigInt(row.gas)]);
  const report = {
    données: data.source, lignes: data.rows, octets: data.csv.length, tempsTotalMs: totalMs, entraînementNominalMs: trainingMs, deuxEntraînementsSimultanésMs: parallelMs,
    règlementsSimultanésRefusés: concurrentSettleErrors, retenueCsvInvalide: invalidFee.toString(), retenue9999Lignes: smallFee.toString(),
    métriques: model.metrics, aucRecalculée: auc, refus: rejected, soldes: snapshots, transactions: gasRows,
    gasParFonction: Object.fromEntries([...gasByFunction].map(([fn, values]) => [fn, { n: values.length, min: `${values.reduce((a, b) => (b < a ? b : a))}`, max: `${values.reduce((a, b) => (b > a ? b : a))}` }])),
    plafonds: caps.log,
    gasParRôle: Object.fromEntries([...new Set(gasRows.map((row) => row.de))].map((role) => {
      const mine = gasRows.filter((row) => row.de === role);
      return [role, { transactions: mine.length, gas: `${mine.reduce((sum, row) => sum + BigInt(row.gas), BigInt(0))}`,
        coûtWeiLocal: `${mine.reduce((sum, row) => sum + BigInt(row.coûtWei), BigInt(0))}` }];
    })),
  };
  const out = reportFile;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`[parcours] ${gasRows.length} transactions, ${rejected.length} refus vérifiés, durée totale ${totalMs} ms, mesures : ${out}`);
  console.table(Object.fromEntries([...gasByFunction].map(([fn, values]) => [fn, { n: values.length, max: Number(values.reduce((a, b) => (b > a ? b : a))) }])));
  runnerBudget()!.close();

  // ---------------------------------------------------------------- plafonds bêta via prepareLoan (base simulée en mémoire)
  async function capsScenario() {
    const log: string[] = [];
    const lockedLoans: Locked[] = [];
    let unlocked: SignedComputeQuote | undefined;
    const { prisma } = await import("@/lib/db");
    const { currentRunnerProvenance } = await import("@/lib/runner/provenance");
    // Sans RUNNER_URL, Next appelle le runner dans le même processus (mode développement).
    const provenance = await currentRunnerProvenance();
    type Row = Record<string, unknown> & { id: string; status: string; amountUsdcAtomic: string; createdAt: Date };
    let rows: Row[] = [];
    let counter = 0;
    const matches = (row: Row, where: Record<string, unknown> = {}): boolean => Object.entries(where).every(([field, condition]) => {
      const value = row[field];
      if (field === "OR") return (condition as Record<string, unknown>[]).some((alt) => matches(row, alt));
      if (condition === null || typeof condition !== "object" || condition instanceof Date) return (value ?? null) === condition;
      const c = condition as { in?: unknown[]; not?: unknown; gte?: Date; gt?: Date };
      if (c.in && !c.in.includes(value)) return false;
      if ("not" in c && value === c.not) return false;
      if (c.gte && !(value instanceof Date && value >= c.gte)) return false;
      return true;
    });
    const loanTable = {
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length,
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).map((row) => ({ amountUsdcAtomic: row.amountUsdcAtomic })),
      updateMany: async ({ where, data: values }: { where: Record<string, unknown>; data: object }) => {
        const hit = rows.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, values);
        return { count: hit.length };
      },
      create: async ({ data: values }: { data: Record<string, unknown> }) => {
        const row = { id: `plafond-${++counter}`, status: "PENDING", evmLockTxHash: null, cancelTxHash: null, createdAt: new Date(), ...values } as unknown as Row;
        rows.push(row);
        return { ...row };
      },
      update: async ({ where, data: values }: { where: { id: string }; data: object }) => {
        const row = rows.find((candidate) => candidate.id === where.id)!;
        Object.assign(row, values);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const kept = rows.filter((row) => !matches(row, where));
        const count = rows.length - kept.length;
        rows = kept;
        return { count };
      },
    };
    const datasetRow = {
      id: dataset.datasetId, status: "LISTED", evmDatasetId: onChainDatasetId, listingExpiresAt: null, priceUsdcAtomic: String(PRICE),
      ipfsCid: dataset.cid, wrappedKey: dataset.wrappedKey, merkleRoot: dataset.merkleRoot, runnerReceipt: datasetReceipt,
      modelId: GBDT.modelId, modelVersion: GBDT.modelVersion, provider: accounts.fournisseur.address.toLowerCase(), challengeDays: 1, ...provenance,
    };
    let queue: Promise<unknown> = Promise.resolve();
    const original = { transaction: prisma.$transaction, findUnique: prisma.dataset.findUnique, deleteMany: prisma.loan.deleteMany };
    Reflect.set(prisma, "$transaction", (action: (tx: unknown) => Promise<unknown>) => {
      // Exécution une par une : l'équivalent d'une isolation sérialisable sans conflit.
      const next = queue.then(() => action({ loan: loanTable, dataset: { updateMany: async () => ({ count: 1 }) } }));
      queue = next.catch(() => undefined);
      return next;
    });
    Reflect.set(prisma.dataset, "findUnique", async () => ({ ...datasetRow }));
    Reflect.set(prisma.loan, "deleteMany", loanTable.deleteMany);
    const { prepareLoan } = await import("@/lib/sirius/borrower");
    const setCaps = (perLoan: string, total: string) => Object.assign(process.env, { SIRIUS_MAX_LOAN_USDC: perLoan, SIRIUS_MAX_EXPOSURE_USDC: total });
    try {
      // A. Prix du dataset (5) au-delà du plafond par prêt (4) : refus avant tout appel au runner.
      setCaps("4", "100");
      const allocated = runnerBudget()!.snapshot().allocatedWei;
      await expectRunnerError("plafond par prêt 4 < prix 5", prepareLoan(dataset.datasetId, accounts.acheteur.address), /plafond par prêt/);
      assert.equal(runnerBudget()!.snapshot().allocatedWei, allocated, "aucun devis réservé");
      assert.equal(rows.length, 0);
      log.push("A : plafond par prêt 4 USDC < prix 5 USDC → refus avant le runner, aucune ligne, aucun devis");
      // B. Prix 5 sous le plafond (6) mais total du devis 7 au-dessus : refus après le devis, ligne supprimée.
      setCaps("6", "100");
      await expectRunnerError("plafond par prêt 6 < total devis 7", prepareLoan(dataset.datasetId, accounts.acheteur.address), /plafond par prêt/);
      assert.equal(rows.length, 0, "prêt PENDING supprimé");
      const leaked = runnerBudget()!.snapshot().allocatedWei - allocated;
      log.push(`B : plafond par prêt 6 USDC < total 7 USDC → refus après devis ; réservation runner restée : ${leaked} wei`);
      // C. Exposition totale 13 : deux préparations simultanées de 7 → une seule passe.
      setCaps("7", "13");
      const both = await Promise.allSettled([prepareLoan(dataset.datasetId, accounts.acheteur.address), prepareLoan(dataset.datasetId, accounts.acheteur2.address)]);
      const passed = both.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof prepareLoan>>>[];
      const refused = both.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(passed.length, 1, "exposition 13 : un seul prêt de 7");
      assert.match(refused[0].reason.message, /exposition totale/);
      rejected.push({ label: "exposition totale 13 dépassée par le 2e prêt simultané", error: "Plafond d’exposition totale" });
      log.push("C : exposition 13 USDC, deux préparations simultanées de 7 → une acceptée, une refusée");
      // Le prêt accepté est verrouillé avec la transaction rendue par Next.
      const winner = passed[0].value;
      const party: Party = winner.loan.borrower === accounts.acheteur.address.toLowerCase() ? "acheteur" : "acheteur2";
      assert.equal(winner.loan.amountUsdcAtomic, String(usd(7)));
      await send(`${party} : approve (transaction Next)`, accounts[party], { address: usdc, abi: abi.usdc, functionName: "approve", args: [escrow, usd(7)] });
      const hash = await walletOf(accounts[party]).sendTransaction({ to: winner.lockTransaction.to as Address, data: winner.lockTransaction.data as Hex });
      const lockReceipt = await confirm(hash, `${party} : lock (transaction Next)`);
      onLock(party, usd(7));
      lockedLoans.push({ signed: winner.billingQuote!, loanKey: winner.loan.evmLoanKey as Hex, lockBlock: lockReceipt.blockNumber, total: usd(7), party, buyer: accounts[party] });
      Object.assign(rows.find((row) => row.id === winner.loan.id)!, { status: "ESCROWED", evmLockTxHash: hash });
      // D. Prêt verrouillé (7) compté : une 3e demande (7) dépasse 13.
      await expectRunnerError("exposition totale avec un prêt verrouillé", prepareLoan(dataset.datasetId, accounts.attaquant.address), /exposition totale/);
      // E. Exposition 14 : la même demande passe, mais n'est jamais verrouillée (autorisation laissée expirer).
      setCaps("7", "14");
      const accepted = await prepareLoan(dataset.datasetId, accounts.acheteur2.address);
      unlocked = accepted.billingQuote;
      log.push("D/E : prêt verrouillé compté dans l'exposition ; à 14 USDC la demande suivante passe");
    } finally {
      Reflect.set(prisma, "$transaction", original.transaction);
      Reflect.set(prisma.dataset, "findUnique", original.findUnique);
      Reflect.set(prisma.loan, "deleteMany", original.deleteMany);
      delete process.env.SIRIUS_MAX_LOAN_USDC;
      delete process.env.SIRIUS_MAX_EXPOSURE_USDC;
      await prisma.$disconnect();
    }
    return { log, locked: lockedLoans, unlocked };
  }
});
