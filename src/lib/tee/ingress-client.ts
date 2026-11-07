import { isDemoDeployment } from "@/lib/deployment-mode";
import {
  API_KEY_ID_PATTERN,
  API_KEY_INGRESS_INFO_PREFIX,
  API_KEY_SECRET_BYTES,
  DATASET_INGRESS_INFO_PREFIX,
  MAX_DATASET_BYTES,
  type ApiKeySecretEnvelope,
  type DatasetIngressEnvelope,
  type DatasetIngressKey,
} from "./contract";

const encoder = new TextEncoder();
const BASE64_CHUNK_BYTES = 3 * 8192;

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    encoded += btoa(String.fromCharCode(...chunk));
  }
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Vérifie l’origine et l’empreinte épinglée de la clé d’ingestion ; partagée avec l’envoi en morceaux. */
export async function verifyIngressKey(ingressKey: DatasetIngressKey): Promise<Uint8Array<ArrayBuffer>> {
  if (ingressKey.version !== 1) throw new Error("Version de clé d’ingestion incompatible");
  const expectedOrigin = process.env.NEXT_PUBLIC_SIRIUS_APP_ORIGIN?.trim() || globalThis.location?.origin;
  if (expectedOrigin && ingressKey.origin !== expectedOrigin) {
    throw new Error("La clé d’ingestion n’est pas liée à cette origine");
  }

  const publicKey = decodeBase64Url(ingressKey.publicKey);
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("Clé d’ingestion invalide");

  const expectedFingerprint = process.env.NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256?.trim().toLowerCase();
  // L'épinglage authentifie un runner distant : il prouve que le navigateur chiffre
  // pour l'enclave attendue et non pour un intermédiaire. Sur une instance de
  // démonstration, le runner s'exécute dans le processus qui sert la page — la clé
  // vient de la même origine, et il n'y a aucun tiers à authentifier. Exiger
  // l'empreinte y interdisait tout dépôt sans rien protéger.
  //
  // `instrumentation-node.ts` retirait déjà cette variable des exigences en mode
  // démonstration ; ce contrôle-ci l'ignorait, et les deux se contredisaient.
  if (process.env.NODE_ENV === "production" && !expectedFingerprint && !isDemoDeployment()) {
    throw new Error("Empreinte de clé d’ingestion non configurée");
  }
  if (expectedFingerprint) {
    if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
      throw new Error("Empreinte de clé d’ingestion invalide");
    }
    const fingerprint = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)));
    if (fingerprint !== expectedFingerprint) throw new Error("Clé d’ingestion non authentifiée");
  }
  return publicKey;
}

export async function encryptDatasetForRunner(
  content: ArrayBuffer,
  datasetId: string,
  ingressKey: DatasetIngressKey,
): Promise<DatasetIngressEnvelope> {
  if (content.byteLength === 0 || content.byteLength > MAX_DATASET_BYTES) {
    throw new Error("Taille du dataset invalide");
  }
  return sealForRunner(content, `${DATASET_INGRESS_INFO_PREFIX}${datasetId}`, datasetId, ingressKey);
}

/** ECDH P-256 éphémère avec la clé d'ingestion vérifiée, HKDF-SHA256 (`info`), AES-256-GCM sur `aad`. */
async function sealForRunner(
  content: BufferSource,
  info: string,
  aad: string,
  ingressKey: DatasetIngressKey,
): Promise<DatasetIngressEnvelope> {
  const publicKey = await verifyIngressKey(ingressKey);

  const runnerPublicKey = await crypto.subtle.importKey(
    "raw",
    publicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeralKey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: runnerPublicKey },
    ephemeralKey.privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(info),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad), tagLength: 128 },
    encryptionKey,
    content,
  );
  const ephemeralPublicKey = await crypto.subtle.exportKey("raw", ephemeralKey.publicKey);

  return {
    version: 1,
    ephemeralPublicKey: encodeBase64Url(new Uint8Array(ephemeralPublicKey)),
    salt: encodeBase64Url(salt),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * Secret d'une clé API (D-30), généré dans le navigateur : `secret` est le base64url de ses
 * 32 octets ; ce sont ces octets bruts qui sont chiffrés pour l'enclave (HKDF info
 * `sirius-api-key-v1:<keyId>`, AAD = `keyId`). Next ne relaie que l'enveloppe.
 */
export async function encryptApiKeySecretForRunner(
  secret: string,
  keyId: string,
  ingressKey: DatasetIngressKey,
): Promise<ApiKeySecretEnvelope> {
  if (!API_KEY_ID_PATTERN.test(keyId)) throw new Error("Identifiant de clé API invalide");
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Secret de clé API invalide");
  const bytes = decodeBase64Url(secret);
  if (bytes.length !== API_KEY_SECRET_BYTES) throw new Error("Secret de clé API invalide");
  try {
    return await sealForRunner(bytes, `${API_KEY_INGRESS_INFO_PREFIX}${keyId}`, keyId, ingressKey);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Empreinte signée dans le grant `register-api-key` : SHA-256 hexadécimal du JSON de l'enveloppe,
 * clés dans l'ordre `version, ephemeralPublicKey, salt, iv, ciphertext` (même calcul dans l'enclave).
 */
export async function apiKeyEnvelopeSha256(envelope: ApiKeySecretEnvelope): Promise<string> {
  const canonical = JSON.stringify({
    version: envelope.version,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    salt: envelope.salt,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
  });
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical))));
}
