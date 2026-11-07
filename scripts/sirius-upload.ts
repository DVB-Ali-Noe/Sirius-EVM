/**
 * CLI d'envoi d'un gros dataset (jusqu'à 1 Go), pour les équipes techniques et l'automatisation
 * (docs/UPLOAD-1GO.md, §6). Même code que le site : contrôle du CSV en flux, chiffrement sur la
 * machine pour l'enclave, morceaux envoyés directement dans R2, scellement par l'enclave. Le titre
 * on-chain se publie ensuite depuis le site (Mes datasets → Publier), avec le wallet.
 *
 *   SIRIUS_URL=https://… SIRIUS_PRIVATE_KEY=0x… SIRIUS_INGRESS_KEY_SHA256=… \
 *     pnpm upload:cli data.csv --name "Transactions 2025" --category finance --price 10
 *
 * Options : --model (linear_regression par défaut), --description, --max-rental-days (30),
 * --listing-days (30), --consent (consentement à l'amélioration des modèles).
 * `SIRIUS_INGRESS_KEY_SHA256` épingle la clé de l'enclave : obligatoire hors localhost.
 * `SIRIUS_COOKIE` ajoute un cookie (porte d'aperçu d'un déploiement de test).
 * La clé privée ne quitte pas la machine : elle signe la connexion, rien d'autre.
 */
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { parseDelegationMessage, runnerGrantMessage, runnerIntent, type RunnerGrant } from "@/lib/runner/authorization-contract";
import { csvRejectionText } from "@/lib/datasets/csv-check";
import { inspectStreamSummary, readLargeCsv } from "@/lib/datasets/csv-check-stream";
import { checkDraftResponse } from "@/lib/datasets/draft-response";
import { DATASET_CATEGORIES, type DatasetCategory, type ListingDurationDays } from "@/lib/datasets/publication";
import { MODEL_OPTIONS, type ModelId } from "@/lib/models/registry";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { encodeBase64Url } from "@/lib/upload/chunked";
import { sendChunkedDataset, type ChunkedFileSource, type ChunkedTransferApi } from "@/lib/upload/chunked-transfer";

const GRANT_TTL_MS = 60_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function interpolate(key: string, params: Record<string, string | number> = {}): string {
  return key.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fileSource(path: string): Promise<ChunkedFileSource & { close(): Promise<void> }> {
  const handle = await open(path, "r");
  const { size } = await handle.stat();
  return {
    sizeBytes: size,
    async read(offset, length) {
      const buffer = new Uint8Array(new ArrayBuffer(length));
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return done === length ? buffer : buffer.slice(0, done);
    },
    close: () => handle.close(),
  };
}

function progressBar(fraction: number): string {
  const width = 30;
  const filled = Math.round(fraction * width);
  return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${Math.floor(fraction * 100)} %`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      description: { type: "string" },
      category: { type: "string" },
      price: { type: "string" },
      model: { type: "string", default: "linear_regression" },
      "max-rental-days": { type: "string", default: "30" },
      "listing-days": { type: "string", default: "30" },
      consent: { type: "boolean", default: false },
    },
  });
  const [path] = positionals;
  const origin = process.env.SIRIUS_URL?.replace(/\/+$/, "");
  const privateKey = process.env.SIRIUS_PRIVATE_KEY?.trim();
  if (!path || !values.name || !values.category || !values.price) {
    fail("Usage : pnpm upload:cli <fichier.csv> --name <nom> --category <catégorie> --price <gain par jour> [--model …]");
  }
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) fail("SIRIUS_URL manquante ou invalide (ex. https://sirius-data.tech)");
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail("SIRIUS_PRIVATE_KEY manquante ou invalide");
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const pin = process.env.SIRIUS_INGRESS_KEY_SHA256?.trim().toLowerCase();
  if (!pin && !local) fail("SIRIUS_INGRESS_KEY_SHA256 obligatoire : empreinte de la clé d'ingestion de l'enclave");
  // Insensible à la casse (`finance` comme `Finance`) : la valeur envoyée est l'écriture exacte de la liste.
  const category = DATASET_CATEGORIES.find((name) => name.toLowerCase() === values.category!.trim().toLowerCase());
  if (!category) fail(`Catégorie inconnue. Choix : ${DATASET_CATEGORIES.join(", ")}`);
  if (!MODEL_OPTIONS.some((model) => model.id === values.model)) fail(`Profil inconnu. Choix : ${MODEL_OPTIONS.map((model) => model.id).join(", ")}`);
  const modelId = values.model as ModelId;
  const priceUsdcAtomic = priceUsdcToAtomic(values.price);
  if (!priceUsdcAtomic) fail("Prix invalide (0.001 à 1 000 000 par jour)");
  const maxRentalDays = Number(values["max-rental-days"]);
  const listingDays = Number(values["listing-days"]) as ListingDurationDays;

  // La vérification de la clé d'ingestion partagée avec le site lit ces deux réglages.
  process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN = origin;
  if (pin) process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256 = pin;
  const { verifyIngressKey } = await import("@/lib/tee/ingress-client");

  const source = await fileSource(path);
  try {
    // 1. Contrôle local, mêmes règles que le site et l'enclave.
    process.stdout.write("Contrôle du fichier…\n");
    const read = await readLargeCsv(source, (fraction) => process.stdout.write(`\r${progressBar(fraction)}`));
    process.stdout.write("\n");
    if (!read.ok) fail(`Fichier refusé : ${csvRejectionText(read.reason, interpolate)}`);
    const inspection = inspectStreamSummary(read.summary, modelId);
    if (!inspection.ok) fail(`Fichier refusé : ${csvRejectionText(inspection.reason, interpolate)}`);
    console.log(`${inspection.summary.rowCount} lignes, cible « ${inspection.summary.target} », racine ${read.merkleRoot}`);

    // 2. Connexion : défi signé par le wallet, qui délègue une clé de session à la CLI.
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const sessionKey = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const sessionPublicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", sessionKey.publicKey)));
    let cookie = process.env.SIRIUS_COOKIE?.trim() ?? "";
    const request: ChunkedTransferApi["request"] = (requestPath, init) =>
      fetch(`${origin}${requestPath}`, {
        ...init,
        headers: { ...init.headers, origin, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) },
        redirect: "error",
      });
    const json = async <T>(response: Response): Promise<T> => {
      const body = (await response.json().catch(() => ({}))) as T & { error?: string };
      if (!response.ok) fail(body.error ?? `Requête refusée (HTTP ${response.status})`);
      return body;
    };
    const post = (requestPath: string, body: unknown) =>
      request(requestPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const { challenge } = await json<{ challenge: string }>(
      await post("/api/auth/challenge", { address: account.address, runnerSessionPublicKey: sessionPublicKey }),
    );
    const walletSignature = await account.signMessage({ message: challenge });
    const verified = await post("/api/auth/verify", { address: account.address, signature: walletSignature, message: challenge, source: "external" });
    await json(verified);
    const session = verified.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    if (!session) fail("Connexion refusée : aucune session reçue");
    cookie = [cookie, session].filter(Boolean).join("; ");
    // Mêmes champs que le navigateur : adresse, réseau et échéance lus dans le message signé.
    const fields = parseDelegationMessage(challenge);
    if (!fields || fields.sessionPublicKey !== sessionPublicKey) fail("Défi de connexion invalide");
    const { network, expiresAt: delegationExpiresAt } = fields;
    const delegation = { message: challenge, walletSignature, sessionPublicKey };
    console.log(`Connecté : ${account.address} (${network})`);

    const issueGrant = async (datasetId: string, intentParts: readonly string[]): Promise<RunnerGrant> => {
      const now = Date.now();
      const payload = {
        version: 1 as const,
        operation: "seal-chunked-dataset" as const,
        subject: fields.address,
        network,
        datasetId,
        payloadHash: await sha256Hex(runnerIntent(intentParts)),
        nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(18))),
        issuedAt: now,
        expiresAt: Math.min(now + GRANT_TTL_MS, delegationExpiresAt),
      };
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        sessionKey.privateKey,
        new TextEncoder().encode(runnerGrantMessage(payload)),
      );
      return { delegation, payload, signature: encodeBase64Url(new Uint8Array(signature)) };
    };

    // 3. Brouillon, avec relecture des termes avant de chiffrer quoi que ce soit.
    const draft = checkDraftResponse(
      await json(await post("/api/datasets", {
        name: values.name,
        description: values.description || undefined,
        sizeBytes: source.sizeBytes,
        priceUsdc: values.price,
        category,
        maxRentalDays,
        listingDays,
        trainingConsent: values.consent,
        modelId,
        transfer: "chunked",
      })),
      {
        priceUsdcAtomic,
        sizeBytes: source.sizeBytes,
        modelId,
        category: category as DatasetCategory,
        maxRentalDays,
        listingDays,
        trainingConsent: Boolean(values.consent),
      },
    );
    console.log(`Brouillon ${draft.datasetId}`);

    // 4. Chiffrement, envoi, scellement.
    let sealing = false;
    await sendChunkedDataset(
      { datasetId: draft.datasetId, priceUsdcAtomic: draft.priceUsdcAtomic, challengeDays: draft.challengeDays,
        maxRentalDays: draft.maxRentalDays, sizeBytes: draft.sizeBytes, model: draft.model },
      source,
      {
        api: { request, put: (url, body, signal) => fetch(url, { method: "PUT", body, signal }) },
        verifyIngressKey,
        issueGrant,
        onProgress: (progress) => {
          if (progress.phase === "upload") process.stdout.write(`\rEnvoi ${progressBar(progress.sentBytes / progress.totalBytes)}`);
          else if (!sealing) {
            sealing = true;
            process.stdout.write("\nScellement par l'enclave…\n");
          }
        },
      },
    );
    console.log(`Scellé. Publie le titre on-chain depuis ${origin}/datasets (brouillon ${draft.datasetId}).`);
  } finally {
    await source.close();
  }
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
