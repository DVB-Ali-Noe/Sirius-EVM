import { AppError } from "../src/lib/app-error";

const DIAGNOSTICS: Record<string, string> = {
  P1000: "authentification PostgreSQL refusée",
  P1001: "serveur PostgreSQL inaccessible",
  P1002: "délai de connexion PostgreSQL dépassé",
  P1011: "connexion TLS PostgreSQL refusée",
  P1013: "URL PostgreSQL invalide",
  P1017: "connexion PostgreSQL fermée",
  P2010: "requête SQL refusée",
  P2024: "attente du pool PostgreSQL expirée",
  P2039: "erreur du pilote PostgreSQL",
  "28P01": "authentification PostgreSQL refusée",
  "28000": "accès PostgreSQL refusé",
  "3D000": "base PostgreSQL inexistante",
  "42P01": "table PostgreSQL absente",
  "42703": "colonne PostgreSQL absente",
  "42501": "permissions PostgreSQL insuffisantes",
  "53300": "trop de connexions PostgreSQL",
  ENOTFOUND: "résolution DNS impossible",
  EAI_AGAIN: "résolution DNS temporairement indisponible",
  ECONNREFUSED: "connexion réseau refusée",
  ECONNRESET: "connexion réseau interrompue",
  ETIMEDOUT: "délai réseau dépassé",
  ENETUNREACH: "réseau inaccessible",
  ERR_TLS_CERT_ALTNAME_INVALID: "nom du certificat TLS incompatible",
  CERT_HAS_EXPIRED: "certificat TLS expiré",
  DEPTH_ZERO_SELF_SIGNED_CERT: "certificat TLS autosigné non approuvé",
  SELF_SIGNED_CERT_IN_CHAIN: "chaîne TLS non approuvée",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificat TLS non vérifiable",
  DatabaseNotReachable: "serveur PostgreSQL inaccessible",
  AuthenticationFailed: "authentification PostgreSQL refusée",
  DatabaseAccessDenied: "accès PostgreSQL refusé",
  DatabaseDoesNotExist: "base PostgreSQL inexistante",
  TableDoesNotExist: "table PostgreSQL absente",
  ColumnNotFound: "colonne PostgreSQL absente",
  TooManyConnections: "trop de connexions PostgreSQL",
  TlsConnectionError: "connexion TLS PostgreSQL refusée",
  ConnectionClosed: "connexion PostgreSQL fermée",
  SocketTimeout: "délai réseau dépassé",
  HttpRequestError: "requête HTTP RPC échouée",
  TimeoutError: "délai RPC dépassé",
  RpcRequestError: "requête refusée par le RPC",
  ContractFunctionExecutionError: "lecture du contrat échouée",
  ContractFunctionZeroDataError: "aucune donnée renvoyée par le contrat",
};

export function preflightErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const details = new Set<string>();
  const visited = new Set<object>();
  function inspect(value: unknown, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) return;
    visited.add(value);
    const record = value as Record<string, unknown>;
    // Les messages, URL, requêtes SQL et métadonnées libres peuvent contenir des secrets.
    for (const key of ["code", "originalCode", "kind", "name"]) {
      const code = record[key];
      if (typeof code === "string" && Object.hasOwn(DIAGNOSTICS, code)) {
        details.add(`${code} : ${DIAGNOSTICS[code]}`);
      }
    }
    for (const key of ["cause", "meta", "driverAdapterError"]) inspect(record[key], depth + 1);
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors.slice(0, 20)) inspect(nested, depth + 1);
    }
  }
  inspect(error);
  return `Préflight EVM impossible à la dernière étape annoncée${details.size ? ` — ${[...details].join(" ; ")}` : " — erreur technique non classée"}`;
}
