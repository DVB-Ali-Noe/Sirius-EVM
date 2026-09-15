import "server-only";
import { AppError } from "@/lib/app-error";

const UPLOAD_ENDPOINT = "https://uploads.pinata.cloud/v3/files";

export interface IpfsUpload {
  cid: string;
  size: number;
}

function getJwt(): string {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new Error("PINATA_JWT manquante");
  return jwt;
}

function getGateway(): string {
  return (process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud").replace(/\/+$/, "");
}

/** Upload d'un blob (déjà chiffré) sur IPFS public via Pinata. Renvoie le CID. */
export async function uploadToIpfs(data: Buffer, name: string): Promise<IpfsUpload> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(data)]), name);
  form.append("network", "public");

  const res = await fetch(UPLOAD_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${getJwt()}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Pinata upload échoué (${res.status}): ${await res.text()}`);
  }

  const { data: payload } = (await res.json()) as { data: { cid: string; size: number } };
  return { cid: payload.cid, size: payload.size };
}

/** Une tentative de lecture, bornée dans le temps. */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [400, 1_200];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Récupère le blob chiffré depuis le gateway IPFS.
 *
 * Le gateway public de Pinata met plusieurs secondes à répondre et refuse les rafales
 * venant d'adresses partagées — celles d'un hébergeur serverless, précisément. Une seule
 * réponse 429 ou 5xx faisait tomber le téléchargement d'un modèle pourtant livré et payé,
 * sous un « erreur interne » qui n'accusait personne.
 *
 * On retente donc sur les refus transitoires, avec un délai par tentative pour ne pas
 * rester suspendu, et on termine sur une AppError : son message est sûr — pas d'URL, pas
 * de jeton — et son statut dit la vérité, le stockage est indisponible, pas le serveur en
 * faute. Un 404 n'est pas transitoire et ne se retente pas.
 */
export async function fetchFromIpfs(cid: string): Promise<Buffer> {
  const url = `${getGateway()}/ipfs/${cid}`;
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) throw new AppError("Fichier introuvable sur IPFS", 404);
      lastStatus = res.status;
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Réseau coupé ou délai dépassé : transitoire, on retente comme un 5xx.
      lastStatus = null;
    }
    if (attempt < FETCH_ATTEMPTS) await wait(FETCH_BACKOFF_MS[attempt - 1]);
  }
  console.error(`[ipfs] lecture échouée après ${FETCH_ATTEMPTS} tentatives${lastStatus ? ` (dernier statut ${lastStatus})` : ""}`);
  throw new AppError("Stockage IPFS indisponible — réessaie dans un instant.", 503);
}

const FILES_API = "https://api.pinata.cloud/v3/files/public";

/**
 * Dépinne un CID de notre compte Pinata (API v3 : résout le(s) file id par CID
 * puis DELETE). Best-effort : ne garantit pas la disparition du réseau IPFS public
 * (d'autres nœuds peuvent avoir répliqué) → la vraie garantie d'effacement reste le
 * crypto-shredding (destruction de la DEK). No-op si le CID n'est plus référencé.
 */
export async function unpinFromIpfs(cid: string): Promise<void> {
  const auth = { Authorization: `Bearer ${getJwt()}` };

  const listRes = await fetch(`${FILES_API}?cid=${encodeURIComponent(cid)}`, { headers: auth });
  if (!listRes.ok) throw new Error(`Pinata list échoué (${listRes.status}): ${await listRes.text()}`);
  const { data } = (await listRes.json()) as { data: { files: { id: string }[] } };

  await Promise.all(
    (data?.files ?? []).map(async (file) => {
      const del = await fetch(`${FILES_API}/${file.id}`, { method: "DELETE", headers: auth });
      if (!del.ok && del.status !== 404) {
        throw new Error(`Pinata delete échoué (${del.status}) pour ${file.id}`);
      }
    }),
  );
}
