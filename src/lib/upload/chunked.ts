/**
 * Envoi d'un dataset en morceaux chiffrés (jusqu'à 1 Gio), partagé par le site, la CLI et l'enclave.
 *
 * Seulement Web Crypto : le même code tourne dans le navigateur, dans Node (CLI) et dans le runner.
 * Conception : `docs/UPLOAD-1GO.md`, section 4.
 *
 * - Clé d'envoi `K` : ECDH P-256 éphémère avec la clé d'ingestion de l'enclave, puis HKDF-SHA256
 *   (info `sirius-dataset-upload-v1:<datasetId>:<uploadId>`). Seule l'enclave peut la recalculer.
 * - Morceau `i` : AES-256-GCM avec `K`, IV aléatoire, et en données associées le dataset, l'envoi,
 *   l'indice, le nombre de morceaux et la taille claire. Un morceau déplacé, retiré, dupliqué ou
 *   venu d'un autre envoi ne se déchiffre pas. Objet stocké = IV (12 octets) ‖ chiffré ‖ tag (16).
 * - Racine du clair : exactement celle de `buildMerkleTree` (feuilles de 64 Kio) sur le fichier
 *   entier ; les morceaux font un multiple de 64 Kio, donc leurs feuilles se suivent sans couture.
 * - Racine du chiffré : même arbre, une feuille par morceau sur le SHA-256 de l'objet stocké.
 *   Tout le monde peut la recalculer en retéléchargeant les objets.
 */

export const CHUNKED_UPLOAD_VERSION = 1;
export const MERKLE_LEAF_BYTES = 64 * 1024; // = DEFAULT_CHUNK_SIZE de `@/lib/crypto/merkle`
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const MIN_UPLOAD_CHUNK_BYTES = MERKLE_LEAF_BYTES;
export const MAX_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
export const MAX_CHUNKED_DATASET_BYTES = 1024 * 1024 * 1024;
export const UPLOAD_KEY_INFO_PREFIX = "sirius-dataset-upload-v1:";
const CHUNK_AAD_LABEL = "sirius-chunk-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const P256_PUBLIC_KEY_BYTES = 65;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;
const encoder = new TextEncoder();

export interface UploadIds {
  datasetId: string;
  uploadId: string;
}

/** Ce que l'enclave doit connaître pour recalculer `K` : rien de secret. */
export interface UploadKeyEnvelope {
  version: 1;
  ephemeralPublicKey: string;
  salt: string;
}

export interface UploadChunkRecord {
  index: number;
  plainBytes: number;
  /** SHA-256 de l'objet stocké (IV ‖ chiffré ‖ tag), en hexadécimal. */
  sha256: string;
}

export interface ChunkedUploadManifest extends UploadIds {
  version: 1;
  key: UploadKeyEnvelope;
  plainBytes: number;
  chunkBytes: number;
  chunkCount: number;
  chunks: UploadChunkRecord[];
  plaintextRoot: string;
  ciphertextRoot: string;
}

export interface EncryptedChunk {
  index: number;
  object: Uint8Array<ArrayBuffer>;
  sha256: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Encodages

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_RE.test(value)) throw new Error("Encodage base64url invalide");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

// ---------------------------------------------------------------------------------------------------------------
// Découpage

function assertIds({ datasetId, uploadId }: UploadIds): void {
  if (!ID_RE.test(datasetId)) throw new Error("Identifiant de dataset invalide");
  if (!ID_RE.test(uploadId)) throw new Error("Identifiant d'envoi invalide");
}

export function assertChunkBytes(chunkBytes: number): void {
  if (
    !Number.isSafeInteger(chunkBytes) ||
    chunkBytes < MIN_UPLOAD_CHUNK_BYTES ||
    chunkBytes > MAX_UPLOAD_CHUNK_BYTES ||
    chunkBytes % MERKLE_LEAF_BYTES !== 0
  ) {
    throw new Error("Taille de morceau invalide");
  }
}

export function assertPlainBytes(plainBytes: number): void {
  if (!Number.isSafeInteger(plainBytes) || plainBytes <= 0 || plainBytes > MAX_CHUNKED_DATASET_BYTES) {
    throw new Error("Taille du dataset invalide");
  }
}

export function chunkCountFor(plainBytes: number, chunkBytes = UPLOAD_CHUNK_BYTES): number {
  assertPlainBytes(plainBytes);
  assertChunkBytes(chunkBytes);
  return Math.ceil(plainBytes / chunkBytes);
}

/** Taille claire du morceau `index` : `chunkBytes`, sauf le dernier. */
export function chunkPlainBytes(index: number, plainBytes: number, chunkBytes = UPLOAD_CHUNK_BYTES): number {
  const count = chunkCountFor(plainBytes, chunkBytes);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Indice de morceau invalide");
  return index === count - 1 ? plainBytes - chunkBytes * (count - 1) : chunkBytes;
}

// ---------------------------------------------------------------------------------------------------------------
// Clé d'envoi

/** HKDF commun aux deux côtés : le fournisseur (ECDH Web Crypto) et l'enclave (ECDH de sa clé d'ingestion). */
export async function uploadKeyFromSharedSecret(
  sharedSecret: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  ids: UploadIds,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  assertIds(ids);
  if (sharedSecret.length !== 32) throw new Error("Secret partagé invalide");
  if (salt.length !== SALT_BYTES) throw new Error("Sel invalide");
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: encoder.encode(`${UPLOAD_KEY_INFO_PREFIX}${ids.datasetId}:${ids.uploadId}`),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

/**
 * Côté fournisseur : `recipientPublicKey` est la clé d'ingestion brute (65 octets), déjà vérifiée
 * par l'appelant (épinglage, chaîne KMS). La clé privée éphémère n'est jamais exportée.
 */
export async function createUploadKey(
  recipientPublicKey: Uint8Array<ArrayBuffer>,
  ids: UploadIds,
): Promise<{ key: CryptoKey; envelope: UploadKeyEnvelope }> {
  if (recipientPublicKey.length !== P256_PUBLIC_KEY_BYTES || recipientPublicKey[0] !== 4) {
    throw new Error("Clé d'ingestion invalide");
  }
  const recipient = await crypto.subtle.importKey(
    "raw",
    recipientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256),
  );
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await uploadKeyFromSharedSecret(sharedSecret, salt, ids, ["encrypt"]);
  const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  return {
    key,
    envelope: { version: 1, ephemeralPublicKey: encodeBase64Url(ephemeralPublicKey), salt: encodeBase64Url(salt) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Morceaux

/** Données associées : un tableau JSON de valeurs validées, donc sans ambiguïté de découpage. */
export function chunkAad(ids: UploadIds, index: number, chunkCount: number, plainBytes: number): Uint8Array<ArrayBuffer> {
  assertIds(ids);
  return encoder.encode(JSON.stringify([CHUNK_AAD_LABEL, ids.datasetId, ids.uploadId, index, chunkCount, plainBytes]));
}

export async function encryptChunk(
  key: CryptoKey,
  ids: UploadIds,
  index: number,
  chunkCount: number,
  plain: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: chunkAad(ids, index, chunkCount, plain.length), tagLength: 128 },
      key,
      plain,
    ),
  );
  const object = new Uint8Array(IV_BYTES + sealed.length);
  object.set(iv, 0);
  object.set(sealed, IV_BYTES);
  return object;
}

/** Côté enclave. `plainBytes` vient du manifeste : il fait partie des données associées. */
export async function decryptChunk(
  key: CryptoKey,
  ids: UploadIds,
  index: number,
  chunkCount: number,
  plainBytes: number,
  object: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (object.length !== IV_BYTES + plainBytes + TAG_BYTES) throw new Error("Morceau chiffré invalide");
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: object.subarray(0, IV_BYTES),
          additionalData: chunkAad(ids, index, chunkCount, plainBytes),
          tagLength: 128,
        },
        key,
        object.subarray(IV_BYTES),
      ),
    );
  } catch {
    throw new Error("Morceau chiffré invalide");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Arbres de Merkle (même construction que `@/lib/crypto/merkle`)

/** Feuilles du clair d'un morceau : une par tranche de 64 Kio. */
export async function plaintextLeaves(plain: Uint8Array<ArrayBuffer>): Promise<string[]> {
  const leaves: string[] = [];
  for (let offset = 0; offset < plain.length; offset += MERKLE_LEAF_BYTES) {
    const slice = plain.subarray(offset, Math.min(offset + MERKLE_LEAF_BYTES, plain.length));
    leaves.push(toHex(await sha256(Uint8Array.of(LEAF_PREFIX), slice)));
  }
  return leaves;
}

export async function merkleRootFromLeaves(leaves: string[]): Promise<string> {
  if (leaves.length === 0) throw new Error("Arbre de Merkle vide");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(toHex(await sha256(Uint8Array.of(NODE_PREFIX), fromHex(left), fromHex(right))));
    }
    level = next;
  }
  return level[0];
}

export async function ciphertextRoot(chunks: UploadChunkRecord[]): Promise<string> {
  const leaves: string[] = [];
  for (const chunk of chunks) leaves.push(toHex(await sha256(Uint8Array.of(LEAF_PREFIX), fromHex(chunk.sha256))));
  return merkleRootFromLeaves(leaves);
}

// ---------------------------------------------------------------------------------------------------------------
// Chiffreur d'un envoi

/**
 * Chiffre un fichier morceau par morceau, dans n'importe quel ordre (envoi parallèle, reprise),
 * en gardant seulement les feuilles et les empreintes : jamais plus d'un morceau clair en mémoire
 * par appel. `manifest()` exige que tous les morceaux soient passés.
 */
export class ChunkedUploadEncryptor {
  readonly chunkCount: number;
  private readonly leaves: (string[] | undefined)[];
  private readonly records: (UploadChunkRecord | undefined)[];

  private constructor(
    private readonly key: CryptoKey,
    readonly envelope: UploadKeyEnvelope,
    readonly ids: UploadIds,
    readonly plainBytes: number,
    readonly chunkBytes: number,
  ) {
    this.chunkCount = chunkCountFor(plainBytes, chunkBytes);
    this.leaves = new Array(this.chunkCount);
    this.records = new Array(this.chunkCount);
  }

  static async create(input: {
    recipientPublicKey: Uint8Array<ArrayBuffer>;
    ids: UploadIds;
    plainBytes: number;
    chunkBytes?: number;
  }): Promise<ChunkedUploadEncryptor> {
    const chunkBytes = input.chunkBytes ?? UPLOAD_CHUNK_BYTES;
    chunkCountFor(input.plainBytes, chunkBytes);
    const { key, envelope } = await createUploadKey(input.recipientPublicKey, input.ids);
    return new ChunkedUploadEncryptor(key, envelope, { ...input.ids }, input.plainBytes, chunkBytes);
  }

  async encrypt(index: number, plain: Uint8Array<ArrayBuffer>): Promise<EncryptedChunk> {
    if (plain.length !== chunkPlainBytes(index, this.plainBytes, this.chunkBytes)) {
      throw new Error("Taille de morceau inattendue");
    }
    const object = await encryptChunk(this.key, this.ids, index, this.chunkCount, plain);
    const digest = toHex(await sha256(object));
    this.leaves[index] = await plaintextLeaves(plain);
    this.records[index] = { index, plainBytes: plain.length, sha256: digest };
    return { index, object, sha256: digest };
  }

  async manifest(): Promise<ChunkedUploadManifest> {
    const chunks: UploadChunkRecord[] = [];
    const leaves: string[] = [];
    for (let i = 0; i < this.chunkCount; i++) {
      const record = this.records[i];
      const chunkLeaves = this.leaves[i];
      if (!record || !chunkLeaves) throw new Error(`Morceau ${i} pas encore chiffré`);
      chunks.push(record);
      leaves.push(...chunkLeaves);
    }
    return {
      version: CHUNKED_UPLOAD_VERSION,
      datasetId: this.ids.datasetId,
      uploadId: this.ids.uploadId,
      key: this.envelope,
      plainBytes: this.plainBytes,
      chunkBytes: this.chunkBytes,
      chunkCount: this.chunkCount,
      chunks,
      plaintextRoot: await merkleRootFromLeaves(leaves),
      ciphertextRoot: await ciphertextRoot(chunks),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Manifeste

/** JSON à ordre de clés fixe : son SHA-256 identifie l'envoi (il remplace le CID IPFS dans `cidHash`). */
export function canonicalManifestJson(manifest: ChunkedUploadManifest): string {
  return JSON.stringify({
    version: manifest.version,
    datasetId: manifest.datasetId,
    uploadId: manifest.uploadId,
    key: { version: manifest.key.version, ephemeralPublicKey: manifest.key.ephemeralPublicKey, salt: manifest.key.salt },
    plainBytes: manifest.plainBytes,
    chunkBytes: manifest.chunkBytes,
    chunkCount: manifest.chunkCount,
    chunks: manifest.chunks.map((chunk) => ({ index: chunk.index, plainBytes: chunk.plainBytes, sha256: chunk.sha256 })),
    plaintextRoot: manifest.plaintextRoot,
    ciphertextRoot: manifest.ciphertextRoot,
  });
}

export async function manifestSha256(manifest: ChunkedUploadManifest): Promise<string> {
  return toHex(await sha256(encoder.encode(canonicalManifestJson(manifest))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lit un manifeste venu du réseau (site ou enclave) et vérifie tout ce qui ne demande pas de
 * secret : forme, tailles cohérentes, indices dans l'ordre, racine du chiffré. La racine du clair
 * ne peut être vérifiée que par l'enclave, après déchiffrement.
 */
export async function parseChunkedUploadManifest(value: unknown): Promise<ChunkedUploadManifest> {
  const invalid = (reason: string) => new Error(`Manifeste invalide : ${reason}`);
  if (!isRecord(value) || value.version !== CHUNKED_UPLOAD_VERSION) throw invalid("version");
  const { datasetId, uploadId, key, plainBytes, chunkBytes, chunkCount, chunks, plaintextRoot } = value;
  if (typeof datasetId !== "string" || typeof uploadId !== "string") throw invalid("identifiants");
  const ids = { datasetId, uploadId };
  try {
    assertIds(ids);
  } catch {
    throw invalid("identifiants");
  }
  if (
    !isRecord(key) ||
    key.version !== 1 ||
    typeof key.ephemeralPublicKey !== "string" ||
    typeof key.salt !== "string"
  ) {
    throw invalid("clé d'envoi");
  }
  try {
    if (decodeBase64Url(key.ephemeralPublicKey).length !== P256_PUBLIC_KEY_BYTES) throw new Error();
    if (decodeBase64Url(key.salt).length !== SALT_BYTES) throw new Error();
  } catch {
    throw invalid("clé d'envoi");
  }
  if (typeof plainBytes !== "number" || typeof chunkBytes !== "number" || typeof chunkCount !== "number") {
    throw invalid("tailles");
  }
  let expectedCount: number;
  try {
    expectedCount = chunkCountFor(plainBytes, chunkBytes);
  } catch {
    throw invalid("tailles");
  }
  if (chunkCount !== expectedCount || !Array.isArray(chunks) || chunks.length !== chunkCount) {
    throw invalid("nombre de morceaux");
  }
  const records: UploadChunkRecord[] = chunks.map((chunk, i) => {
    if (
      !isRecord(chunk) ||
      chunk.index !== i ||
      chunk.plainBytes !== chunkPlainBytes(i, plainBytes, chunkBytes) ||
      typeof chunk.sha256 !== "string" ||
      !HEX64_RE.test(chunk.sha256)
    ) {
      throw invalid(`morceau ${i}`);
    }
    return { index: i, plainBytes: chunk.plainBytes, sha256: chunk.sha256 };
  });
  if (typeof plaintextRoot !== "string" || !HEX64_RE.test(plaintextRoot)) throw invalid("racine du clair");
  if (value.ciphertextRoot !== (await ciphertextRoot(records))) throw invalid("racine du chiffré");
  return {
    version: CHUNKED_UPLOAD_VERSION,
    datasetId,
    uploadId,
    key: { version: 1, ephemeralPublicKey: key.ephemeralPublicKey, salt: key.salt },
    plainBytes,
    chunkBytes,
    chunkCount,
    chunks: records,
    plaintextRoot,
    ciphertextRoot: value.ciphertextRoot as string,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Emplacements dans le stockage et référence publiée

/** Préfixe de la référence d'un dataset en morceaux, à la place d'un CID IPFS. */
export const CHUNKED_DATASET_CID_PREFIX = "sirius-chunked:v1:";

export function manifestObjectKey(ids: UploadIds): string {
  assertIds(ids);
  return `datasets/${ids.datasetId}/${ids.uploadId}/manifest.json`;
}

export function chunkObjectKey(ids: UploadIds, index: number): string {
  assertIds(ids);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Indice de morceau invalide");
  return `datasets/${ids.datasetId}/${ids.uploadId}/chunks/${index}`;
}

/**
 * Référence publiée du dataset (`cid` du titre, dont `cidHash` est inscrit on-chain) : elle désigne
 * l'envoi et s'engage sur l'empreinte de son manifeste, donc sur chaque morceau stocké.
 */
export function chunkedDatasetCid(uploadId: string, manifestSha: string): string {
  if (!ID_RE.test(uploadId) || !HEX64_RE.test(manifestSha)) throw new Error("Référence de dataset invalide");
  return `${CHUNKED_DATASET_CID_PREFIX}${uploadId}:${manifestSha}`;
}

export function parseChunkedDatasetCid(cid: string): { uploadId: string; manifestSha: string } | null {
  if (!cid.startsWith(CHUNKED_DATASET_CID_PREFIX)) return null;
  const [uploadId, manifestSha, ...rest] = cid.slice(CHUNKED_DATASET_CID_PREFIX.length).split(":");
  if (rest.length > 0 || !ID_RE.test(uploadId ?? "") || !HEX64_RE.test(manifestSha ?? "")) return null;
  return { uploadId, manifestSha };
}
