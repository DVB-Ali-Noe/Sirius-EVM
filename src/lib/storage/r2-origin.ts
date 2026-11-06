/**
 * Origine R2 que le navigateur doit pouvoir joindre pour les gros envois.
 *
 * Le site signe une URL courte par morceau et le navigateur y envoie le chiffré directement
 * (`src/lib/upload/chunked-transfer.ts`). Sans cette origine dans `connect-src`, notre propre
 * politique bloque le `PUT` : la requête échoue sans code HTTP (« Envoi du morceau 1 impossible »).
 *
 * Seul le point d'accès du compte configuré est ouvert, pas tout `*.r2.cloudflarestorage.com`.
 * Sans compte valide (instance sans gros envois), rien n'est ajouté. Module sans dépendance :
 * le proxy l'importe sans charger le client R2 et ses accès.
 */
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;

export function r2BrowserOrigin(accountId: string | undefined): string | null {
  const account = accountId?.trim();
  return account && ACCOUNT_ID_RE.test(account) ? `https://${account}.r2.cloudflarestorage.com` : null;
}
