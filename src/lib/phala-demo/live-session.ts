/**
 * Session de training Phala ouverte au public sur demo.sirius-data.tech.
 *
 * Le site lit l'état public de la démo côté serveur : la fenêtre du dashboard n'apparaît
 * que pendant une session réellement ouverte et disparaît d'elle-même à sa fermeture.
 */
export const LIVE_DEMO_URL = "https://demo.sirius-data.tech";

export function liveDemoOpen(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const state = body as { phase?: unknown; available?: unknown };
  return state.phase === "open" && state.available === true;
}
