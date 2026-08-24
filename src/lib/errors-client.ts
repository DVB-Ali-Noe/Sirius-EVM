/** Message d'erreur sûr côté client : un SDK wallet peut rejeter avec autre chose qu'un Error. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue";
}
