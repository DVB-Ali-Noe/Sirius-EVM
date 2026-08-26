/**
 * Bandeau de démonstration.
 *
 * Rendu côté serveur, sans état ni interaction : il ne doit pas dépendre de
 * l'hydratation, sinon il disparaîtrait précisément dans les cas où l'instance va
 * mal — c'est-à-dire là où il est le plus utile.
 *
 * Il n'est pas refermable. Un visiteur qui le masque, puis prend une capture d'écran
 * ou envoie le lien, ferait circuler une démonstration présentée comme le produit.
 */
export function DemoBanner() {
  if (process.env.NEXT_PUBLIC_SIRIUS_DEPLOYMENT_MODE !== "demo") return null;

  return (
    <div
      role="status"
      className="relative z-50 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200/90"
    >
      <span className="font-semibold uppercase tracking-widest text-amber-300">Démonstration</span>
      <span className="text-amber-200/70">
        Réseau de test Robinhood Chain · calcul confidentiel non attesté · aucune valeur réelle
      </span>
    </div>
  );
}
