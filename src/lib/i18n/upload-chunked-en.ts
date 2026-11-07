/**
 * Traductions de l'envoi des gros fichiers en morceaux (docs/UPLOAD-1GO.md) : formulaire,
 * module d'envoi, routes `/api/datasets/[id]/uploads`, scellement par l'enclave et stockage R2.
 * Fichier séparé, fusionné dans `EN_MESSAGES`, pour ne pas entrer en conflit avec les autres.
 */
export const UPLOAD_CHUNKED_MESSAGES_EN: Record<string, string> = {
  // Formulaire
  "Lecture du fichier… {percent} %": "Reading file… {percent}%",
  "Gros fichier : il sera chiffré et envoyé en morceaux depuis ce navigateur. Garde la page ouverte pendant l’envoi.":
    "Large file: it will be encrypted and sent in chunks from this browser. Keep the page open during the upload.",
  "{percent} % envoyé": "{percent}% sent",
  "Gros fichiers : cette instance accepte aussi des CSV jusqu’à {maxSize}, chiffrés et envoyés en morceaux ; l’entraînement se fait alors sur un échantillon qui respecte les limites ci-dessous.":
    "Large files: this instance also accepts CSVs up to {maxSize}, encrypted and sent in chunks; training then runs on a sample within the limits below.",
  "Gros fichier : pour l’instant, le modèle est entraîné sur un échantillon fixe de {rows} lignes au plus, réparti sur tout le fichier. Le nombre de lignes utilisées figure dans les métriques du modèle.":
    "Large file: for now, the model is trained on a fixed sample of at most {rows} rows, spread across the whole file. The number of rows used is shown in the model metrics.",

  // Module d'envoi (site et CLI)
  "La taille du fichier a changé depuis la création du brouillon": "The file size changed since the draft was created",
  "Taille de l’envoi incohérente": "Inconsistent upload size",
  "Découpage de l’envoi incohérent": "Inconsistent upload chunking",
  "Lecture du fichier incomplète": "Incomplete file read",
  "URL d’envoi manquante": "Missing upload URL",
  "Ouverture de l’envoi refusée": "Upload could not be opened",
  "URL d’envoi refusées": "Upload URLs refused",
  "Clôture de l’envoi refusée": "Upload completion refused",
  "Suivi de l’envoi indisponible": "Upload status unavailable",
  "Scellement refusé": "Sealing refused",
  "Le scellement prend plus de temps que prévu : reviens plus tard sur ce brouillon":
    "Sealing is taking longer than expected: come back to this draft later",

  // Routes d'envoi
  "Envoi des gros fichiers indisponible pour l’instant": "Large file uploads are unavailable for now",
  "SIRIUS_CHUNKED_MAX_BYTES invalide": "Invalid SIRIUS_CHUNKED_MAX_BYTES",
  "Taille de morceau invalide": "Invalid chunk size",
  "Morceaux trop petits pour ce fichier": "Chunks too small for this file",
  "Trop d’envois en cours : termine ou annule un envoi": "Too many uploads in progress: finish or cancel one",
  "Quota d’envoi du jour atteint — réessaie demain": "Daily upload quota reached — try again tomorrow",
  "Envoi introuvable": "Upload not found",
  "Cet envoi n’accepte plus de morceaux": "This upload no longer accepts chunks",
  "Envoi expiré : recommence l’envoi": "Upload expired: start the upload again",
  "Liste de morceaux invalide": "Invalid chunk list",
  "Cet envoi n’attend pas de clôture": "This upload is not waiting for completion",
  "Le manifeste ne correspond pas à cet envoi": "The manifest does not match this upload",
  "Le manifeste ne correspond pas à la taille annoncée": "The manifest does not match the declared size",
  "Envoi déjà clôturé": "Upload already completed",
  "Scellement incohérent avec cet envoi": "Sealing result inconsistent with this upload",
  "Scellement en cours : attends sa fin": "Sealing in progress: wait for it to finish",
  "Envoi déjà scellé": "Upload already sealed",
  "Envoi expiré": "Upload expired",
  "Scellement interrompu : relance la clôture": "Sealing interrupted: complete the upload again",
  "Manifeste manquant": "Missing manifest",

  // Enclave et runner
  "Le manifeste ne correspond pas à ce dataset": "The manifest does not match this dataset",
  "La racine du fichier ne correspond pas au manifeste": "The file root does not match the manifest",
  "Scellement déjà en cours pour cet envoi": "Sealing already in progress for this upload",
  "Un autre scellement est en cours : réessaie dans quelques minutes": "Another sealing is in progress: try again in a few minutes",
  "Runner saturé : réessaie plus tard": "Runner busy: try again later",
  "Scellement inconnu de ce runner : relance la clôture de l’envoi": "Sealing unknown to this runner: complete the upload again",
  "Envoi en morceaux indisponible sur ce runner": "Chunked uploads are unavailable on this runner",
  "Stockage refusé au runner": "Storage refused to the runner",
  "Stockage momentanément injoignable : réessaie dans quelques minutes": "Storage temporarily unreachable: try again in a few minutes",
  "Scellement trop long : réessaie": "Sealing took too long: try again",
  "Scellement interrompu : réessaie": "Sealing interrupted: try again",
  "Clé d'envoi invalide": "Invalid upload key",
  "Flux CSV déjà clos": "CSV stream already closed",

  // Format des morceaux
  "Arbre de Merkle vide": "Empty Merkle tree",
  "Clé d'ingestion invalide": "Invalid ingestion key",
  "Encodage base64url invalide": "Invalid base64url encoding",
  "Identifiant d'envoi invalide": "Invalid upload identifier",
  "Identifiant de dataset invalide": "Invalid dataset identifier",
  "Indice de morceau invalide": "Invalid chunk index",
  "Morceau chiffré invalide": "Invalid encrypted chunk",
  "Référence de dataset invalide": "Invalid dataset reference",
  "Secret partagé invalide": "Invalid shared secret",
  "Taille de morceau inattendue": "Unexpected chunk size",

  // Stockage R2
  "Stockage R2 non configuré": "R2 storage not configured",
  "Stockage injoignable": "Storage unreachable",
  "Durée de validité invalide": "Invalid validity period",
  "Taille d'envoi invalide": "Invalid upload size",
  "Préfixe de suppression invalide": "Invalid deletion prefix",
  "Trop d'objets sous ce préfixe": "Too many objects under this prefix",
};

/** Messages à valeurs (indices, tailles, statuts HTTP), reconnus par motif. */
export const UPLOAD_CHUNKED_DYNAMIC_EN: readonly [RegExp, string][] = [
  [/^Morceau (\d+) absent du stockage$/, "Chunk $1 missing from storage"],
  [/^Morceau (\d+) différent de celui du manifeste$/, "Chunk $1 differs from the manifest"],
  [/^Morceau (\d+) illisible$/, "Chunk $1 unreadable"],
  [/^Morceaux manquants : ([\d, …]+)$/, "Missing chunks: $1"],
  [/^Envoi du morceau (\d+) impossible( \(HTTP \d+\))?$/, "Chunk $1 could not be sent$2"],
  [/^Fichier trop volumineux pour l’envoi en morceaux \(max (\d+) Mo\)$/, "File too large for chunked upload (max $1 MB)"],
  [/^Liste de morceaux invalide \(1 à (\d+)\)$/, "Invalid chunk list (1 to $1)"],
  [/^Lecture du stockage refusée \(HTTP (\d+)\)$/, "Storage read refused (HTTP $1)"],
  [/^Écriture du stockage refusée \(HTTP (\d+)\)$/, "Storage write refused (HTTP $1)"],
  [/^Suppression refusée \(HTTP (\d+)\)$/, "Deletion refused (HTTP $1)"],
  [/^Liste du stockage refusée \(HTTP (\d+)\)$/, "Storage listing refused (HTTP $1)"],
];
