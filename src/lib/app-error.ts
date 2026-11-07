/** Erreur métier volontaire : son message est sûr à exposer au client. Sans dépendance Next
 *  → importable par le runner isolé (inc.3d-B) sans tirer `next/server`. `code` : identifiant
 *  stable d'une erreur de l'API développeurs (D-30), relayé tel quel du runner au client. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}
