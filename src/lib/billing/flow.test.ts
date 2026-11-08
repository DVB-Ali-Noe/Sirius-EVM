import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, http, toHex, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiPrediction, DatasetRef, LoanJobResult, SignedPrediction } from "@/lib/tee/contract";
import type { BudgetPolicy } from "@/lib/runner/budget-ledger";
import type { SignedComputeQuote } from "./quote";

test("devis → lock → runner → crédits et remboursements v7 sur EVM locale", { timeout: 90000 }, async (t) => {
  const env = { ...process.env };
  const fetchOriginal = globalThis.fetch;
  const temporary = mkdtempSync(join(tmpdir(), "sirius-billing-flow-"));
  const portServer = createServer().listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((done) => portServer.close(() => done()));
  const node = spawn(process.execPath, [resolve("node_modules/hardhat/internal/cli/cli.js"), "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: resolve("contracts"), env: { ...process.env, SIRIUS_LOCAL_BILLING_TEST: "true", NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  node.stderr.resume();
  t.after(async () => {
    globalThis.fetch = fetchOriginal;
    node.kill("SIGTERM");
    if (node.exitCode === null) await once(node, "exit");
    rmSync(temporary, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("EVM locale non démarrée")), 20000);
    node.once("exit", () => { clearTimeout(timer); reject(new Error("EVM locale interrompue")); });
    node.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Started HTTP")) { clearTimeout(timer); resolve(); }
    });
  });
  Object.assign(process.env, {
    NODE_ENV: "test", EVM_NETWORK: "testnet", TEE_MODE: "stub", SIRIUS_BILLING_VERSION: "7",
    EVM_RPC_URL: `http://127.0.0.1:${port}`, SIRIUS_APP_ORIGIN: "http://localhost:3000",
    SIRIUS_MASTER_KEY: Buffer.alloc(32, 19).toString("base64"), PINATA_JWT: "synthetic", PINATA_GATEWAY: "https://ipfs.test.invalid",
    RUNNER_BUDGET_FILE: join(temporary, "budget.sqlite"), RUNNER_BILLING_POLICY_FILE: join(temporary, "tariff.json"),
    RUNNER_SERVED_MODELS_DIR: join(temporary, "models"), RUNNER_PREDICT_USAGE_FILE: join(temporary, "usage.sqlite"),
    // Parcours linéaire de bout en bout : profil facultatif depuis D-31, activé explicitement.
    NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS: "linear_regression",
  });
  const { robinhoodTestnet: chain } = await import("@/lib/evm/networks");
  const contracts = chain.contracts;
  chain.contracts = undefined;
  t.after(() => { chain.contracts = contracts; });
  const client = createPublicClient({ chain, transport: http(process.env.EVM_RPC_URL) });
  const accounts = await createWalletClient({ chain, transport: http(process.env.EVM_RPC_URL) }).getAddresses();
  const [admin, provider, treasury] = accounts;
  const borrower = privateKeyToAccount(`0x${"21".repeat(32)}`);
  const runner = (await import("@/lib/evm/runner-account")).settlementAccount();
  process.env.SIRIUS_LOCK_AUTHORIZER = runner.address.toLowerCase();
  async function localRpc(method: string, params: unknown[]) {
    const response = await fetchOriginal(process.env.EVM_RPC_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json();
    assert.equal(body.error, undefined);
    return body.result;
  }
  for (const address of [borrower.address, runner.address]) await localRpc("hardhat_setBalance", [address, toHex(BigInt(10) ** BigInt(20))]);
  const adminWallet = createWalletClient({ account: admin, chain, transport: http(process.env.EVM_RPC_URL) });
  const borrowerWallet = createWalletClient({ account: borrower, chain, transport: http(process.env.EVM_RPC_URL) });
  function artifact(name: string) {
    const folder = name === "MockEscrowToken" ? "test/MockEscrowToken.sol" : `${name}.sol`;
    return JSON.parse(readFileSync(resolve(`contracts/artifacts/src/${folder}/${name}.json`), "utf8")) as { abi: Abi; bytecode: Hex };
  }
  async function deploy(name: string, args: unknown[] = []) {
    const hash = await adminWallet.deployContract({ ...artifact(name), args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt.contractAddress!;
  }
  async function write(name: string, address: Address, functionName: string, args: unknown[], account = admin) {
    const hash = await adminWallet.writeContract({ address, abi: artifact(name).abi, functionName, args, account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }
  const token = await deploy("MockEscrowToken", [18]);
  const kyb = await deploy("SiriusOpenKybRegistry");
  const datasets = await deploy("SiriusDatasetRegistry", [kyb, admin, "0x0000000000000000000000000000000000000000"]);
  const escrow = await deploy("SiriusEscrowV7", [token, kyb, datasets, runner.address]);
  await write("SiriusDatasetRegistry", datasets, "bindEscrow", [escrow]);
  Object.assign(process.env, { SIRIUS_ESCROW_ADDRESS: escrow, SIRIUS_USDC_ADDRESS: token, SIRIUS_KYB_ADDRESS: kyb, SIRIUS_DATASET_ADDRESS: datasets });
  const unit = BigInt(10) ** BigInt(18);
  await write("MockEscrowToken", token, "mint", [borrower.address, unit * BigInt(100)]);
  const { initializeBudgetLedger } = await import("@/lib/runner/budget-ledger");
  const policy: BudgetPolicy = {
    version: 1, chainId: chain.id, wallet: runner.address.toLowerCase(), accountingReference: "synthetic-local-test-only",
    // Budget synthétique assez large pour les prêts, prolongations et packs du scénario D-30.
    validUntil: Date.now() + 4 * 86400000, earnedMarginUsdMicros: "10000000000", cashUsdMicros: "10000000000", fixedReserveUsdMicros: "1000000",
    costsUsdMicros: { request: "1", seal: "50", training: "1000" }, maxFailures: 1, maxActive: 8,
    gas: { totalWei: String(unit), maxTransactionWei: String(unit / BigInt(100)), maxGas: "2000000", maxFeePerGasWei: "10000000000", ethUsdMicrosUpperBound: "5000000000", confirmations: 1 },
  };
  initializeBudgetLedger(process.env.RUNNER_BUDGET_FILE!, policy);
  const profile = { computeAmount: String(unit * BigInt(2)), maxFailureFee: String(unit / BigInt(10)), executionRateAtomicPerMs: "1000000000000", maxExecutionMs: 10000 };
  writeFileSync(process.env.RUNNER_BILLING_POLICY_FILE!, JSON.stringify({
    version: 1, tariffVersion: "synthetic-test-v1", costReference: "not-commercial", validUntil: policy.validUntil,
    chainId: chain.id, usdc: token.toLowerCase(), usdcDecimals: 18, computeRecipient: treasury.toLowerCase(),
    minimumComputeAmount: String(unit * BigInt(3)), noTrainingComputeAmount: String(unit / BigInt(10)),
    apiCallsPerDay: { logistic_regression: 50, gradient_boosted_trees: 100 },
    profiles: { linear_regression: profile, logistic_regression: profile },
  }), { mode: 0o600 });
  const blobs = new Map<string, Buffer>();
  let uploads = 0;
  let reads = 0;
  let failFetch = false;
  let dropNextTransaction = false;
  const runnerBroadcasts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((url === process.env.EVM_RPC_URL || url === `${process.env.EVM_RPC_URL}/`) && typeof init?.body === "string") {
      const rpc = JSON.parse(init.body) as { method: string; id: number; params: string[] };
      if (rpc.method === "eth_sendRawTransaction" && (dropNextTransaction || runnerBroadcasts.length)) {
        runnerBroadcasts.push(rpc.params[0]);
        if (dropNextTransaction) {
          dropNextTransaction = false;
          return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "synthetic connection lost before broadcast" } });
        }
      }
    }
    if (url === "https://uploads.pinata.cloud/v3/files") {
      const file = (init!.body as FormData).get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const cid = `bafy-synthetic-${++uploads}`;
      blobs.set(cid, bytes);
      return Response.json({ data: { cid, size: bytes.length } });
    }
    if (url.startsWith("https://ipfs.test.invalid/ipfs/")) {
      reads++;
      if (failFetch) { await new Promise((done) => setTimeout(done, 25)); return new Response("offline", { status: 503 }); }
      return new Response(new Uint8Array(blobs.get(url.split("/").at(-1)!)!));
    }
    return fetchOriginal(input, init);
  };
  const { sealDataset } = await import("@/lib/tee/core");
  const { issueDatasetReceipt } = await import("@/lib/runner/receipt");
  const { handleRunnerOp } = await import("@/runner/handler");
  const { datasetIdHash, cidHash } = await import("@/lib/evm/dataset-key");
  const { trainingProfileHash } = await import("@/lib/models/registry");
  const { loanKeyFor } = await import("@/lib/evm/loan-key");
  const { siriusescrowv7Abi } = await import("@/lib/evm/abi/siriusescrowv7");
  const { quoteLockTerms, quoteTermsHash, totalQuoteAmount } = await import("./quote");
  const { DAY_MS, RENTAL_GRACE_DAYS } = await import("./rental");
  const { readLoan, reconcileLoanEscrow } = await import("@/lib/evm/escrow");
  const { sweepExpiredLoanModels } = await import("@/lib/tee/served-models");
  const { runnerBudget } = await import("@/lib/runner/budget");
  const { activateRunnerDelegation, beginRunnerDelegation, issueRunnerGrant } = await import("@/lib/runner/authorization-client");
  const { buildDelegationMessage } = await import("@/lib/runner/authorization-contract");
  const { useWalletStore } = await import("@/stores/wallet");
  const csv = Buffer.from("x,y\n" + Array.from({ length: 120 }, (_, i) => `${i},${i * 3 + 1}`).join("\n"));
  const sealed = await sealDataset("dataset", csv);
  const dataset: DatasetRef = { datasetId: "dataset", ...sealed, priceUsdcAtomic: String(unit), challengeDays: 1, maxRentalDays: 30, modelId: "linear_regression", modelVersion: "1.0.0" };
  const datasetReceipt = issueDatasetReceipt(provider.toLowerCase(), dataset);
  await write("SiriusDatasetRegistry", datasets, "mint", [datasetIdHash(dataset.datasetId), cidHash(dataset.cid), `0x${dataset.merkleRoot}`, BigInt(csv.length), trainingProfileHash(dataset)], provider);
  await (await import("@/lib/evm/deployment")).requireCurrentEvmDeployment();
  async function delegate(account: typeof borrower) {
    useWalletStore.getState().setConnected(account.address, "testnet", "external");
    const sessionPublicKey = await beginRunnerDelegation();
    const message = buildDelegationMessage({ origin: "http://localhost:3000", address: account.address, sessionPublicKey, network: "testnet", issuedAt: Date.now(), expiresAt: Date.now() + 60000, challengeToken: "synthetic.challenge" });
    await activateRunnerDelegation({ message, walletSignature: await account.signMessage({ message }), sessionPublicKey });
  }
  await delegate(borrower);
  async function prepare(loanId: string, rental: { rentalDays: number; extendsLoanId?: string } = { rentalDays: 1 }, who: Address = borrower.address) {
    const result = await handleRunnerOp("prepare-escrow-lock", { ...dataset, datasetReceipt, loanId, borrower: who, authorizationDeadline: Math.floor(Date.now() / 1000) + 300, ...rental }) as { billingQuote: SignedComputeQuote };
    // Prolongations et packs (D-30) : frais sans entraînement à prix coûtant, pas le minimum d'un entraînement.
    const noTraining = "extendsLoanId" in rental || "callPack" in rental;
    assert.equal(result.billingQuote.quote.computeAmount, noTraining ? String(unit / BigInt(10)) : String(unit * BigInt(3)));
    if (noTraining) assert.equal(result.billingQuote.quote.maxFailureFee, "0");
    return result.billingQuote;
  }
  const quotes = await Promise.all(["success", "failure", "timeout"].map((loanId) => prepare(loanId)));
  assert.equal(runnerBudget()!.snapshot().allocatedWei, BigInt(policy.gas.maxTransactionWei) * BigInt(6));
  async function run(signed: SignedComputeQuote) {
    const loanId = signed.quote.loanId;
    const authorization = await issueRunnerGrant("run-loan-job", { loanId, datasetId: dataset.datasetId }, [loanId, dataset.datasetId, datasetReceipt, dataset.modelId, dataset.modelVersion, "served"]);
    return handleRunnerOp("run-loan-job", { ...dataset, loanId, datasetReceipt, authorization, billingQuote: signed });
  }
  await assert.rejects(run(quotes[0]), /inactif|scope/);
  assert.equal(reads, 0, "aucun dataset déchiffré avant prépaiement");
  const tampered = structuredClone(quotes[0]);
  tampered.quote.computeAmount = String(unit * BigInt(4));
  await assert.rejects(run(tampered), /Signature/);
  assert.equal(reads, 0);
  async function lock(signed: SignedComputeQuote) {
    const approved = await borrowerWallet.writeContract({ address: token, abi: artifact("MockEscrowToken").abi, functionName: "approve", args: [escrow, BigInt(totalQuoteAmount(signed.quote))] });
    await client.waitForTransactionReceipt({ hash: approved });
    const hash = await borrowerWallet.writeContract({ address: escrow, abi: siriusescrowv7Abi, functionName: "lock", args: [quoteLockTerms(signed.quote), signed.authorization] });
    const block = (await client.waitForTransactionReceipt({ hash })).blockNumber;
    const loan = await readLoan(loanKeyFor(borrower.address, signed.quote.loanId));
    assert.equal(loan?.billing?.termsHash, quoteTermsHash(signed.quote));
    return block;
  }
  const lockBlocks: bigint[] = [];
  for (const signed of quotes) lockBlocks.push(await lock(signed));
  assert.equal(runnerBudget()!.snapshot().failures, 0, "un devis falsifié ou un appel prématuré ne ferme pas la plateforme");
  const result = await run(quotes[0]) as LoanJobResult;
  assert.match(result.modelCid, /^sm1[0-9a-f]{64}$/, "empreinte du modèle scellé, pas un CID IPFS");
  assert.equal(result.loanKey, loanKeyFor(borrower.address, "success"));
  assert.equal(result.hashlock, quotes[0].quote.hashlock);
  assert.equal("releaseEnvelope" in result || "releaseEnvelopeHash" in result, false, "aucune capsule de livraison");
  assert.equal(uploads, 1, "seul le dataset est publié sur IPFS, jamais le modèle");
  const produced = reads;
  assert.equal((await run(quotes[0]) as typeof result).modelCid, result.modelCid);
  assert.equal(reads, produced, "la reprise ne recalcule pas le modèle");
  const recovered = await handleRunnerOp("recover-loan-job", { loanId: "success", billingQuote: quotes[0] }) as {
    state: string; result: typeof result;
  };
  assert.equal(recovered.state, "ready");
  assert.equal(recovered.result.modelCid, result.modelCid);
  assert.equal(recovered.result.runnerReceipt, result.runnerReceipt);
  assert.equal(reads, produced, "la reprise sans grant ne recalcule pas");
  await assert.rejects(handleRunnerOp("recover-loan-job", { loanId: "autre", billingQuote: quotes[0] }), /scope/);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(await handleRunnerOp("recover-loan-job", { loanId: "timeout", billingQuote: quotes[2] }), { state: "missing" });
  }
  const features = { x: 5 };
  const predictRequest = async (settleTxHash: string) => ({ modelRef: { kind: "loan", id: "success" }, features,
    authorization: await issueRunnerGrant("predict", { loanId: "success" }, ["loan", "success", JSON.stringify(features)]),
    loanReceipt: result.runnerReceipt, settleTxHash });
  await assert.rejects(handleRunnerOp("predict", await predictRequest(`0x${"00".repeat(32)}`)), /confirmé/i);
  // Next a perdu la réponse : seules les données préalables au calcul subsistent.
  process.env.DATABASE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  process.env.RUNNER_URL = "http://runner.test.invalid";
  process.env.RUNNER_TRANSPORT_SECRET = Buffer.alloc(32, 9).toString("base64");
  const runnerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://runner.test.invalid/")) {
      const op = url.split("/").at(-1)!;
      if (op === "dataset-ingress-key") return Response.json((await import("@/lib/tee/ingress")).datasetIngressPublicKey());
      try { return Response.json(await handleRunnerOp(op as Parameters<typeof handleRunnerOp>[0], JSON.parse(String(init?.body)))); }
      catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { status?: number }).status ?? 500 }); }
    }
    return runnerFetch(input, init);
  };
  const { prisma } = await import("@/lib/db");
  const { currentRunnerProvenance } = await import("@/lib/runner/provenance");
  const provenance = await currentRunnerProvenance();
  const localLoan: Record<string, unknown> = {
    id: "success", datasetId: dataset.datasetId, borrower: borrower.address.toLowerCase(), provider: provider.toLowerCase(),
    status: "TRAINING", modelCid: null, runnerReceipt: null, updatedAt: new Date(0),
    billingQuote: JSON.stringify(quotes[0]), billingQuoteHash: (await import("./quote")).computeQuoteHash(quotes[0].quote),
    rentalDays: 1, rentalExpiresAt: null, extendsLoanId: null,
    amountUsdcAtomic: totalQuoteAmount(quotes[0].quote), evmHashlock: quotes[0].quote.hashlock,
    evmLoanKey: loanKeyFor(borrower.address, "success"), evmLockBlock: String(lockBlocks[0]),
    evmChainId: chain.id, evmEscrowAddress: escrow.toLowerCase(), modelId: dataset.modelId, modelVersion: dataset.modelVersion,
    ...provenance, dataset: { ...dataset, id: dataset.datasetId, ipfsCid: dataset.cid, ...provenance },
  };
  const originalDb = { findMany: prisma.loan.findMany, findUnique: prisma.loan.findUnique, updateMany: prisma.loan.updateMany };
  Reflect.set(prisma.loan, "findMany", async () => [{ ...localLoan }]);
  Reflect.set(prisma.loan, "findUnique", async () => ({ ...localLoan }));
  Reflect.set(prisma.loan, "updateMany", async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
    if (where.status !== localLoan.status || (where.modelCid === null && localLoan.modelCid !== null)) return { count: 0 };
    Object.assign(localLoan, data, { updatedAt: new Date() });
    return { count: 1 };
  });
  try {
    dropNextTransaction = true;
    await (await import("@/lib/sirius/reaper")).runLoanReaper();
    assert.equal(localLoan.status, "TRAINING", "le premier envoi perdu reste récupérable");
    assert.equal(runnerBroadcasts.length, 1);
    const clock = Date.now;
    const retryAt = clock() + 31000;
    try {
      Date.now = () => retryAt;
      await (await import("@/lib/sirius/reaper")).runLoanReaper();
    } finally { Date.now = clock; }
    assert.equal(localLoan.status, "SETTLED", "le reaper récupère et règle sans nouveau grant");
    assert.equal(localLoan.modelCid, result.modelCid);
    assert.equal(reads, produced, "aucun recalcul après perte de la réponse Next");
    assert.equal(runnerBroadcasts.length, 2);
    assert.equal(runnerBroadcasts[0], runnerBroadcasts[1], "la transaction perdue est rediffusée à l’identique sur l’EVM");
  } finally {
    for (const [key, value] of Object.entries(originalDb)) Reflect.set(prisma.loan, key, value);
    await prisma.$disconnect();
    globalThis.fetch = runnerFetch;
    delete process.env.RUNNER_URL;
  }
  async function settle() {
    return handleRunnerOp("settle-loan", { loanId: "success", loanReceipt: result.runnerReceipt,
      lockBlock: String(lockBlocks[0]) });
  }
  const settled = await settle() as { settleTxHash: string; expiresAt: number };
  const releaseBlock = await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash: settled.settleTxHash as Hex })).blockNumber });
  assert.equal(settled.expiresAt, Number(releaseBlock.timestamp) * 1000 + DAY_MS, "échéance = bloc du release + rentalDays jours");
  // Après règlement confirmé : prédiction signée sur le modèle scellé du prêt (y = 3x + 1).
  const prediction = await handleRunnerOp("predict", await predictRequest(settled.settleTxHash)) as SignedPrediction;
  assert.equal(prediction.modelRef, "loan:success");
  assert.equal(prediction.outputKind, "value");
  assert.equal(prediction.output, "16");
  assert.equal(prediction.counter, 1);
  // Les prédictions ne puisent plus dans le budget de clôture du prêt (16 requêtes) : au-delà, elles
  // passent encore, et le règlement peut toujours être réconcilié ensuite.
  for (let call = 2; call <= 20; call++) {
    assert.equal((await handleRunnerOp("predict", await predictRequest(settled.settleTxHash)) as SignedPrediction).counter, call);
  }
  const nonce = await client.getTransactionCount({ address: runner.address });
  assert.deepEqual(await settle(), settled);
  assert.equal(await client.getTransactionCount({ address: runner.address }), nonce);
  const credit = (account: Address) => client.readContract({ address: escrow, abi: siriusescrowv7Abi, functionName: "creditOf", args: [account] });
  assert.equal(await credit(provider), unit);
  assert.equal(await credit(treasury), unit * BigInt(3));

  // --- Prolongation (D-29) : nouveau lock (prix par jour × jours + compute minimal), release
  // immédiat sans entraînement, échéance repoussée une seule fois. ---
  const stranger = privateKeyToAccount(`0x${"43".repeat(32)}`);
  await assert.rejects(prepare("intrus", { rentalDays: 1, extendsLoanId: "success" }, stranger.address), /réservée à l’emprunteur/,
    "aucun devis de prolongation pour un autre emprunteur");
  const extension = await prepare("ext-1", { rentalDays: 2, extendsLoanId: "success" });
  assert.equal(extension.quote.datasetAmount, String(unit * BigInt(2)), "prix par jour × jours");
  assert.equal(extension.quote.extendsLoanId, "success");
  const extensionLock = await lock(extension);
  await assert.rejects(run(extension), /aucun entraînement/);
  assert.equal(reads, produced, "une prolongation ne déchiffre jamais le dataset");
  const extend = async (signed: SignedComputeQuote, lockBlock: bigint, withGrant = true) => handleRunnerOp("extend-loan", {
    loanId: signed.quote.loanId, originalLoanId: "success", loanReceipt: result.runnerReceipt, billingQuote: signed, lockBlock: String(lockBlock),
    ...(withGrant ? { authorization: await issueRunnerGrant("extend-loan", { loanId: signed.quote.loanId }, [signed.quote.loanId, "success"]) } : {}),
  }) as Promise<{ settleTxHash: string; expiresAt: number }>;
  const extended = await extend(extension, extensionLock);
  assert.equal(extended.expiresAt, settled.expiresAt + 2 * DAY_MS, "prolongée avant l'échéance : repart de l'échéance en cours");
  assert.equal(await credit(provider), unit * BigInt(3), "le provider reçoit les jours prolongés");
  assert.equal(await credit(treasury), unit * BigInt(3) + unit / BigInt(10), "la prolongation ne paie que le frais sans entraînement (D-30)");
  const extensionNonce = await client.getTransactionCount({ address: runner.address });
  assert.deepEqual(await extend(extension, extensionLock, false), extended, "rejouée sans grant : même résultat");
  assert.equal(await client.getTransactionCount({ address: runner.address }), extensionNonce, "rejouée : aucune nouvelle transaction");
  assert.equal((await handleRunnerOp("predict", await predictRequest(settled.settleTxHash)) as SignedPrediction).counter, 21);
  // Un autre emprunteur ne libère pas une prolongation verrouillée ; après la purge, plus aucune.
  const lastExtension = await prepare("ext-2", { rentalDays: 1, extendsLoanId: "success" });
  const lastLock = await lock(lastExtension);
  const lockedStatus = (await readLoan(loanKeyFor(borrower.address, "ext-2")))!.status;
  await delegate(stranger);
  await assert.rejects(extend(lastExtension, lastLock), (error: Error & { status?: number }) =>
    error.status === 403 && /réservée à l’emprunteur/.test(error.message));
  await delegate(borrower);
  // Fournisseur complice (Next compromis) : même identifiant de dataset enregistré sous un autre
  // wallet. Le devis est signé, le lock posé, mais le runner refuse avant tout release.
  const colluder = accounts[4];
  const colludingQuote = async (target: DatasetRef, loanId: string, rental: Record<string, unknown>) => {
    const receipt = issueDatasetReceipt(colluder.toLowerCase(), target);
    return (await handleRunnerOp("prepare-escrow-lock", { ...target, datasetReceipt: receipt, loanId, borrower: borrower.address,
      authorizationDeadline: Math.floor(Date.now() / 1000) + 300, ...rental }) as { billingQuote: SignedComputeQuote }).billingQuote;
  };
  await write("SiriusDatasetRegistry", datasets, "mint", [datasetIdHash(dataset.datasetId), cidHash(dataset.cid), `0x${dataset.merkleRoot}`, BigInt(csv.length), trainingProfileHash(dataset)], colluder);
  const colludingExtension = await colludingQuote(dataset, "ext-colluder", { rentalDays: 1, extendsLoanId: "success" });
  assert.equal(colludingExtension.quote.provider, colluder.toLowerCase());
  const colludingExtensionLock = await lock(colludingExtension);
  const colluderBefore = await credit(colluder);
  await assert.rejects(extend(colludingExtension, colludingExtensionLock), (error: Error & { status?: number }) =>
    error.status === 409 && error.message === "Prolongation : fournisseur différent du prêt d’origine");
  assert.equal(await credit(colluder), colluderBefore, "aucun release vers un autre fournisseur");
  assert.equal((await readLoan(loanKeyFor(borrower.address, "ext-colluder")))!.status, lockedStatus, "prolongation toujours verrouillée");
  const deletion = extended.expiresAt + RENTAL_GRACE_DAYS * DAY_MS;
  assert.equal(sweepExpiredLoanModels(deletion - 1), 0, "gardé scellé pendant le délai de grâce");
  assert.equal(sweepExpiredLoanModels(deletion), 1);
  await assert.rejects(extend(lastExtension, lastLock), (error: Error & { status?: number }) =>
    error.status === 409 && error.message === "Modèle supprimé : location close");
  assert.equal((await readLoan(loanKeyFor(borrower.address, "ext-2")))!.status, lockedStatus, "aucun release après suppression");
  assert.equal(await credit(provider), unit * BigInt(3));
  await assert.rejects(handleRunnerOp("predict", await predictRequest(settled.settleTxHash)), /Modèle supprimé/);

  // --- Packs d'appels (D-30) : prêt logistique loué, pack verrouillé puis libéré sans entraînement,
  // crédité une seule fois au prêt d'origine. Autre fournisseur : les soldes ci-dessous restent exacts. ---
  const apiProvider = accounts[3];
  const apiCsv = Buffer.from("x,label\n" + Array.from({ length: 200 }, (_, i) => `${i},${(i * 7) % 10 < (i < 100 ? 3 : 7) ? 1 : 0}`).join("\n"));
  const apiDataset: DatasetRef = { datasetId: "dataset-api", ...await sealDataset("dataset-api", apiCsv), priceUsdcAtomic: String(unit),
    challengeDays: 1, maxRentalDays: 30, modelId: "logistic_regression", modelVersion: "1.0.0" };
  const apiDatasetReceipt = issueDatasetReceipt(apiProvider.toLowerCase(), apiDataset);
  await write("SiriusDatasetRegistry", datasets, "mint", [datasetIdHash(apiDataset.datasetId), cidHash(apiDataset.cid),
    `0x${apiDataset.merkleRoot}`, BigInt(apiCsv.length), trainingProfileHash(apiDataset)], apiProvider);
  const prepareApi = async (loanId: string, rental: Record<string, unknown>, who: Address = borrower.address) =>
    (await handleRunnerOp("prepare-escrow-lock", { ...apiDataset, datasetReceipt: apiDatasetReceipt, loanId, borrower: who,
      authorizationDeadline: Math.floor(Date.now() / 1000) + 300, ...rental }) as { billingQuote: SignedComputeQuote }).billingQuote;
  const runApi = async (signed: SignedComputeQuote) => handleRunnerOp("run-loan-job", { ...apiDataset, loanId: signed.quote.loanId,
    datasetReceipt: apiDatasetReceipt, billingQuote: signed, authorization: await issueRunnerGrant("run-loan-job",
      { loanId: signed.quote.loanId, datasetId: apiDataset.datasetId },
      [signed.quote.loanId, apiDataset.datasetId, apiDatasetReceipt, apiDataset.modelId, apiDataset.modelVersion, "served"]) });
  // Un jour de location : son échéance tombe avant la fin des budgets de clôture des packs, ce qui
  // permet d'avancer l'horloge de l'enclave jusqu'à elle sans périmer ces budgets.
  const apiQuote = await prepareApi("api-loan", { rentalDays: 1 });
  const apiLock = await lock(apiQuote);
  const apiResult = await runApi(apiQuote) as LoanJobResult;
  const apiSettled = await handleRunnerOp("settle-loan", { loanId: "api-loan", loanReceipt: apiResult.runnerReceipt,
    lockBlock: String(apiLock) }) as { settleTxHash: string; expiresAt: number };
  await assert.rejects(prepareApi("pack-intrus", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" }, stranger.address),
    /réservé à l’emprunteur/, "aucun devis de pack pour un autre emprunteur");
  await assert.rejects(prepareApi("pack-bad", { rentalDays: 1, callPack: 50, packForLoanId: "api-loan" }), /Pack d’appels invalide/);
  const { packDatasetAmount } = await import("./api-pricing");
  const pack = await prepareApi("pack-1", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" });
  assert.equal(pack.quote.datasetAmount, packDatasetAmount(String(unit), 50, 100), "taille × ceil(prix par jour / apiCallsPerDay)");
  assert.equal(pack.quote.maxFailureFee, "0");
  const packLock = await lock(pack);
  await assert.rejects(runApi(pack), /aucun entraînement/);
  const buyCalls = async (signed: SignedComputeQuote, lockBlock: bigint, withGrant = true) => handleRunnerOp("buy-calls", {
    loanId: signed.quote.loanId, originalLoanId: "api-loan", loanReceipt: apiResult.runnerReceipt, billingQuote: signed, lockBlock: String(lockBlock),
    ...(withGrant ? { authorization: await issueRunnerGrant("buy-calls", { loanId: signed.quote.loanId }, [signed.quote.loanId, "api-loan"]) } : {}),
  }) as Promise<{ settleTxHash: string; credits: number }>;
  const apiProviderCredit = await credit(apiProvider);
  const bought = await buyCalls(pack, packLock);
  assert.equal(bought.credits, 100);
  assert.equal(await credit(apiProvider), apiProviderCredit + BigInt(pack.quote.datasetAmount), "le fournisseur reçoit le prix du pack");
  const packNonce = await client.getTransactionCount({ address: runner.address });
  assert.deepEqual(await buyCalls(pack, packLock, false), bought, "rejoué sans grant : même résultat, un seul crédit");
  assert.equal(await client.getTransactionCount({ address: runner.address }), packNonce, "rejoué : aucune nouvelle transaction");
  // Un autre emprunteur ne libère pas un pack verrouillé.
  const secondPack = await prepareApi("pack-2", { rentalDays: 1, callPack: 1000, packForLoanId: "api-loan" });
  const secondLock = await lock(secondPack);
  await delegate(stranger);
  await assert.rejects(buyCalls(secondPack, secondLock), (error: Error & { status?: number }) =>
    error.status === 403 && /réservé à l’emprunteur/.test(error.message));
  await delegate(borrower);
  // Pack payé à un fournisseur complice : refusé avant tout release, aucun crédit.
  await write("SiriusDatasetRegistry", datasets, "mint", [datasetIdHash(apiDataset.datasetId), cidHash(apiDataset.cid),
    `0x${apiDataset.merkleRoot}`, BigInt(apiCsv.length), trainingProfileHash(apiDataset)], colluder);
  const colludingPack = await colludingQuote(apiDataset, "pack-colluder", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" });
  const colludingPackLock = await lock(colludingPack);
  const colluderBeforePack = await credit(colluder);
  await assert.rejects(buyCalls(colludingPack, colludingPackLock), (error: Error & { status?: number }) =>
    error.status === 409 && error.message === "Pack d’appels : fournisseur différent du prêt d’origine");
  assert.equal(await credit(colluder), colluderBeforePack, "aucun release vers un autre fournisseur");
  assert.equal((await readLoan(loanKeyFor(borrower.address, "pack-colluder")))!.status, lockedStatus, "pack toujours verrouillé");
  // Un pack payé n'est jamais perdu : coupure simulée entre la release (publiée par le même code que
  // buy-calls) et le crédit, puis rejeu après un changement de politique ou l'échéance de la location.
  const { settleBilledEscrow } = await import("./settlement");
  const { escrowLock } = await import("@/lib/tee/core");
  const releaseWithoutCredit = async (signed: SignedComputeQuote, lockBlock: bigint) => {
    const before = await credit(apiProvider);
    await settleBilledEscrow(signed.quote, loanKeyFor(signed.quote.borrower, signed.quote.loanId),
      escrowLock(signed.quote.loanId, signed.quote.borrower).preimage, lockBlock);
    assert.equal(await credit(apiProvider), before + BigInt(signed.quote.datasetAmount), "release publiée, pack pas encore crédité");
  };
  await releaseWithoutCredit(secondPack, secondLock);
  const tariffFile = process.env.RUNNER_BILLING_POLICY_FILE!;
  const tariff = readFileSync(tariffFile, "utf8");
  writeFileSync(tariffFile, JSON.stringify({ ...JSON.parse(tariff), apiCallsPerDay: { gradient_boosted_trees: 100 } }));
  await assert.rejects(prepareApi("pack-closed", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" }), /API indisponible/,
    "profil retiré de l'API : plus aucun nouveau pack");
  const afterPolicy = await client.getTransactionCount({ address: runner.address });
  assert.equal((await buyCalls(secondPack, secondLock, false)).credits, 1100, "politique changée après paiement : pack crédité quand même");
  assert.equal(await client.getTransactionCount({ address: runner.address }), afterPolicy, "rejeu de la release, aucune nouvelle transaction");
  writeFileSync(tariffFile, tariff);
  const thirdPack = await prepareApi("pack-3", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" });
  const thirdLock = await lock(thirdPack);
  await releaseWithoutCredit(thirdPack, thirdLock);
  // Un pack trop tardif (moins d'une heure de location) est refusé avant tout paiement.
  const latePack = await prepareApi("pack-4", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" });
  const lateLock = await lock(latePack);
  const enclaveClock = Date.now;
  try {
    Date.now = () => apiSettled.expiresAt + 1000;
    assert.equal((await buyCalls(thirdPack, thirdLock, false)).credits, 1200, "location expirée depuis la release : pack crédité quand même");
    Date.now = () => apiSettled.expiresAt - 30 * 60_000;
    const ending = (error: Error & { status?: number; code?: string }) => error.status === 409 && error.code === "rental_ending";
    await assert.rejects(prepareApi("pack-late", { rentalDays: 1, callPack: 100, packForLoanId: "api-loan" }), ending);
    const lateCredit = await credit(apiProvider);
    const lateNonce = await client.getTransactionCount({ address: runner.address });
    await assert.rejects(buyCalls(latePack, lateLock, false), ending);
    assert.equal(await credit(apiProvider), lateCredit, "aucune release");
    assert.equal(await client.getTransactionCount({ address: runner.address }), lateNonce, "aucune transaction");
  } finally { Date.now = enclaveClock; }
  assert.equal((await buyCalls(latePack, lateLock)).credits, 1300, "à plus d'une heure de l'échéance : libéré, packs cumulés");
  // Clé API sur le prêt v7 réglé : quota du jour du profil d'abord, crédits intacts.
  const { apiKeyEnvelopeSha256, encryptApiKeySecretForRunner } = await import("@/lib/tee/ingress-client");
  const { datasetIngressPublicKey } = await import("@/lib/tee/ingress");
  const { apiCanonicalString } = await import("./api-pricing");
  const apiKey = { keyId: randomBytes(16).toString("base64url"), secret: randomBytes(32) };
  const envelope = await encryptApiKeySecretForRunner(apiKey.secret.toString("base64url"), apiKey.keyId, datasetIngressPublicKey());
  await handleRunnerOp("register-api-key", { loanId: "api-loan", keyId: apiKey.keyId, envelope, loanReceipt: apiResult.runnerReceipt,
    settleTxHash: apiSettled.settleTxHash, authorization: await issueRunnerGrant("register-api-key", { loanId: "api-loan" },
      ["api-loan", apiKey.keyId, await apiKeyEnvelopeSha256(envelope)]) });
  const apiBody = JSON.stringify({ features: { x: 5 } });
  const apiCall = { method: "POST", path: "/v1/models/api-loan/predict", timestamp: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString("base64url") };
  const apiPrediction = await handleRunnerOp("api-predict", { ...apiCall, loanId: "api-loan", keyId: apiKey.keyId, body: apiBody,
    loanReceipt: apiResult.runnerReceipt, settleTxHash: apiSettled.settleTxHash,
    signature: createHmac("sha256", apiKey.secret).update(apiCanonicalString({ ...apiCall,
      bodySha256Hex: createHash("sha256").update(apiBody).digest("hex") })).digest("hex") }) as ApiPrediction;
  assert.deepEqual([apiPrediction.modelRef, apiPrediction.remaining, apiPrediction.expiresAt],
    ["loan:api-loan", { today: 49, credits: 1300 }, apiSettled.expiresAt]);
  failFetch = true;
  await assert.rejects(run(quotes[1]), /remboursement crédité/);
  const failed = await readLoan(loanKeyFor(borrower.address, "failure"));
  assert.equal(failed?.status, 4);
  const fee = BigInt(failed!.billing!.consumedCompute);
  assert.ok(fee > BigInt(0) && fee <= BigInt(quotes[1].quote.maxFailureFee));
  assert.equal(await credit(borrower.address), unit * BigInt(4) - fee);
  assert.equal(await credit(provider), unit * BigInt(3), "dataset intégralement remboursé après échec");
  const resolution = await reconcileLoanEscrow(loanKeyFor(borrower.address, "failure"), lockBlocks[1]);
  assert.equal(resolution.state, "cancelled");
  await localRpc("evm_increaseTime", [86401]);
  await localRpc("evm_mine", []);
  await write("SiriusEscrowV7", escrow, "refund", [loanKeyFor(borrower.address, "timeout")]);
  await write("SiriusEscrowV7", escrow, "refund", [loanKeyFor(borrower.address, "ext-2")]);
  // timeout (1 + 3) et prolongation ext-2 (1 jour + frais sans entraînement 0,1) remboursés en entier.
  assert.equal(await credit(borrower.address), unit * BigInt(9) + unit / BigInt(10) - fee, "sans exécution ni release, remboursement intégral");
  // Locks payés aux fournisseurs complices, jamais libérés : remboursés en entier à l'échéance.
  const beforeColluderRefunds = await credit(borrower.address);
  await write("SiriusEscrowV7", escrow, "refund", [loanKeyFor(borrower.address, "ext-colluder")]);
  await write("SiriusEscrowV7", escrow, "refund", [loanKeyFor(borrower.address, "pack-colluder")]);
  assert.equal(await credit(borrower.address), beforeColluderRefunds + BigInt(totalQuoteAmount(colludingExtension.quote))
    + BigInt(totalQuoteAmount(colludingPack.quote)));
  const [locked, owed, balance] = await client.readContract({ address: escrow, abi: siriusescrowv7Abi, functionName: "accounting" });
  assert.equal(locked, BigInt(0));
  assert.equal(owed, balance);
  await write("SiriusEscrowV7", escrow, "withdrawFor", [borrower.address]);
  assert.equal(await credit(borrower.address), BigInt(0));

  // Relayeur réel : il paie le gas du retrait, les fonds partent au seul titulaire du crédit.
  const relayerKey = `0x${"37".repeat(32)}` as Hex;
  const relayerAddress = privateKeyToAccount(relayerKey).address;
  await localRpc("hardhat_setBalance", [relayerAddress, toHex(BigInt(10) ** BigInt(18))]);
  const { createWithdrawRelayer, withdrawRelayerConfig } = await import("@/lib/sirius/withdraw-relayer");
  const relayer = createWithdrawRelayer(withdrawRelayerConfig({ SIRIUS_WITHDRAW_RELAYER_ENABLED: "true", SIRIUS_WITHDRAW_RELAYER_KEY: relayerKey,
    SIRIUS_WITHDRAW_RELAYER_MIN_USDC: "1", SIRIUS_WITHDRAW_RELAYER_DAILY_GAS_ETH: "0.1" })!, undefined,
  async () => [{ key: `${escrow}:${provider}`, escrow, account: provider }]);
  const providerBalance = () => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [provider] });
  const before = await providerBalance();
  await relayer.run();
  assert.equal(await credit(provider), BigInt(0));
  assert.equal(await providerBalance(), before + unit * BigInt(3));
  assert.ok(await client.getBalance({ address: relayerAddress }) < BigInt(10) ** BigInt(18), "gas payé par le relayeur");
  const relayerNonce = await client.getTransactionCount({ address: relayerAddress });
  await relayer.run();
  assert.equal(await client.getTransactionCount({ address: relayerAddress }), relayerNonce, "crédit soldé : aucun nouvel envoi");
  runnerBudget()!.close();
});
