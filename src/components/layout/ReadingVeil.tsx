/**
 * Pages de lecture (conditions, confidentialité, mentions, statut, preuves, certificats) : le blob du
 * fond reste visible sur les bords mais s'efface derrière la colonne de texte, qui sinon devenait
 * illisible là où l'anneau la croisait (retour du 12 novembre 2026).
 */
export function ReadingVeil() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(ellipse_75%_70%_at_50%_45%,rgba(11,11,11,0.95),rgba(11,11,11,0.85)_55%,rgba(11,11,11,0.5))]"
    />
  );
}
