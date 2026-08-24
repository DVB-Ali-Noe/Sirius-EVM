/**
 * Lecture du solde XRP d'une adresse, côté client, via le proxy same-origin
 * `/api/xrpl-rpc` (rippled n'a pas de CORS, cf. D-22). Read-only.
 *
 * Retourne le solde en XRP (number). Un compte non activé (réserve non payée)
 * n'existe pas au ledger → `account_info` renvoie `actNotFound` : on le traduit
 * en `{ activated: false, xrp: 0 }` plutôt qu'une erreur.
 */
export interface XrplBalance {
  activated: boolean;
  xrp: number;
}

export async function fetchXrpBalance(address: string): Promise<XrplBalance> {
  const res = await fetch("/api/xrpl-rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "validated" }],
    }),
  });
  if (!res.ok) throw new Error("Solde indisponible");

  const body = await res.json();
  const error = body?.result?.error;
  if (error === "actNotFound") return { activated: false, xrp: 0 };
  if (error) throw new Error("Solde indisponible");

  const drops = body?.result?.account_data?.Balance;
  if (typeof drops !== "string") throw new Error("Solde indisponible");
  return { activated: true, xrp: Number(drops) / 1_000_000 };
}
