import "server-only";
import { AppError } from "@/lib/app-error";
import { adminAllowed } from "@/lib/auth/admin";
import type { Session } from "@/lib/auth/session";

/**
 * Message renvoyé à un wallet qui n'a pas accès au self training. Volontairement pauvre :
 * il ne confirme ni l'existence de la fonction, ni la raison du refus, ni la liste des accès.
 */
export const SELF_TRAINING_UNAVAILABLE = "Bientôt disponible";

/**
 * Instance de démonstration Phala ([12](docs/passage-mainnet/12-test-phala.md)) : la démo
 * publique EST un self training sur ses propres données, porté par les mêmes routes
 * `/api/train`. Elle n'existe que sur le testnet ; `requiresPhalaRunner` refuse de démarrer
 * une démo hors testnet, et cette fonction l'exige une seconde fois. Sur mainnet, elle
 * renvoie donc toujours faux : aucune exemption n'est possible en production.
 */
export function phalaDemoInstance(env: Record<string, string | undefined> = process.env): boolean {
  return env.SIRIUS_PHALA_DEMO === "true" && env.EVM_NETWORK === "testnet";
}

/** Un grant runner émis par le parcours de démo porte la révision de session de la démo. */
export function isDemoTrainingGrant(grant: unknown): boolean {
  if (typeof grant !== "object" || grant === null) return false;
  const payload = (grant as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return false;
  return Number.isSafeInteger((payload as { demoSessionRevision?: unknown }).demoSessionRevision);
}

export function selfTrainingUnavailable(): AppError {
  return new AppError(SELF_TRAINING_UNAVAILABLE, 403);
}

/**
 * Garde côté serveur de toutes les routes de self training. À appeler juste après
 * `requireAuth`, avant toute lecture de corps, toute requête en base, toute vérification de
 * grant et tout appel runner : un refus ne coûte rien et ne consomme aucun budget runner.
 *
 * - Administrateur (`SIRIUS_ADMIN_ADDRESSES`) : accès.
 * - Sinon, uniquement si `demoAccess` est vrai ET que l'instance est une démo Phala sur
 *   testnet : la part publique de la démo (liste des jobs, entraînement porté par un grant
 *   de démo) reste accessible aux visiteurs, comme avant cette garde.
 * - Sinon : 403 « Bientôt disponible ».
 */
export function assertSelfTrainingAccess(session: Session, demoAccess = false): void {
  if (adminAllowed(session.address)) return;
  if (demoAccess && phalaDemoInstance()) return;
  throw selfTrainingUnavailable();
}
