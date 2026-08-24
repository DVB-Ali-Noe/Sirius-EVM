import "server-only";

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

/** Récupère le blob chiffré depuis le gateway IPFS. */
export async function fetchFromIpfs(cid: string): Promise<Buffer> {
  const res = await fetch(`${getGateway()}/ipfs/${cid}`);
  if (!res.ok) throw new Error(`IPFS fetch échoué (${res.status}) pour ${cid}`);
  return Buffer.from(await res.arrayBuffer());
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
