/**
 * Traductions de l'API développeurs (D-30) : attentes expliquées (`WaitSteps`), démarrage de
 * l'enclave, panneau API de la page Train (clés, packs d'appels) et devis de pack. Fichier séparé,
 * fusionné dans `EN_MESSAGES`. « en attente », « en cours », « fait », « Copier », « Copié »,
 * « Réessayer » et « Annuler » existent déjà ailleurs.
 */
export const DEVELOPER_API_MESSAGES_EN: Record<string, string> = {
  // Tarif des appels (src/lib/billing/api-pricing.ts)
  "Le quota d'appels par jour doit être un entier entre 1 et 10 000.": "The daily call quota must be an integer between 1 and 10,000.",
  "Taille de pack d'appels invalide.": "Invalid call pack size.",
  "L'horodatage doit être un entier en secondes.": "The timestamp must be an integer number of seconds.",
  // Attente expliquée (src/components/ui/WaitSteps.tsx)
  "erreur": "error",
  "Temps restant estimé : ~{seconds} s": "Estimated time left: ~{seconds} s",
  "Temps restant estimé : ~{minutes} min": "Estimated time left: ~{minutes} min",
  "Tu peux fermer cette page : l’opération continue sans toi.": "You can close this page: the operation continues without you.",
  "Garde cette page ouverte jusqu’à la fin de l’opération.": "Keep this page open until the operation finishes.",

  // Démarrage de l'enclave (EnclaveStartingSteps, enclave-wait.ts)
  "L’enclave démarre": "The enclave is starting",
  "Démarrage demandé": "Start requested",
  "Démarrage de la machine confidentielle": "Booting the confidential machine",
  "Quelques minutes : Sirius n’allume l’enclave que lorsqu’elle sert, et la paie.":
    "A few minutes: Sirius only runs the enclave when it is needed, and pays for it.",
  "Vérification de l’enclave, puis reprise automatique": "Enclave verification, then automatic resume",
  "Nouvel essai dans ~{seconds} s": "Retrying in ~{seconds} s",
  "L’enclave démarre. La demande reprendra dès qu’elle sera prête.": "The enclave is starting. The request will resume as soon as it is ready.",
  "Si tu fermes la page, l’enclave continue de démarrer : relance ta prédiction dans quelques minutes, rien n’est décompté.":
    "If you close the page, the enclave keeps starting: request your prediction again in a few minutes, nothing is counted.",

  // Clés API (src/lib/train/api-keys-client.ts, CreateApiKeyDialog)
  "Chargement des clés API impossible": "Could not load API keys",
  "Création de la clé API échouée": "API key creation failed",
  "Révocation de la clé API échouée": "API key revocation failed",
  "Nom de clé invalide (1 à 64 caractères)": "Invalid key name (1 to 64 characters)",
  "Clé d’ingestion de l’enclave absente": "Enclave ingress key missing",
  "Vérification de l’accès et de l’enclave": "Checking access and the enclave",
  "Génération de la clé et scellement du secret pour l’enclave": "Generating the key and sealing the secret for the enclave",
  "Signature de l’autorisation": "Signing the authorization",
  "Enregistrement dans l’enclave": "Registering in the enclave",
  "Créer une clé API": "Create an API key",
  "Copie cette clé maintenant : elle ne sera plus jamais affichée. Sirius ne la conserve pas en clair ; seule l’enclave en garde le secret.":
    "Copy this key now: it will never be shown again. Sirius does not keep it in clear; only the enclave holds the secret.",
  "J’ai copié la clé": "I copied the key",
  "Nom de la clé": "Key name",
  "ex. serveur de production": "e.g. production server",
  "La clé est générée dans ton navigateur. Son secret est chiffré pour l’enclave avant d’être envoyé : ni Sirius ni le serveur web ne peuvent signer d’appel à ta place.":
    "The key is generated in your browser. Its secret is encrypted for the enclave before it is sent: neither Sirius nor the web server can sign a call on your behalf.",
  "Création…": "Creating…",
  "Créer la clé": "Create key",

  // Panneau API (src/components/train/ApiPanel.tsx)
  "API indisponible pour la régression linéaire (le modèle serait reconstructible).":
    "API unavailable for linear regression (the model could be reconstructed).",
  "API développeurs": "Developer API",
  "Documentation de l’API": "API documentation",
  "Appelle ce modèle depuis ton code avec une clé signée. Le quota de {calls} appels par jour est commun au site et à l’API ; les appels achetés prennent le relais une fois le quota du jour épuisé.":
    "Call this model from your code with a signed key. The quota of {calls} calls per day is shared by the site and the API; purchased calls take over once the day's quota is used up.",
  "Tu peux fermer cette page : tes appels reçoivent « 503 enclave_starting » avec un délai Retry-After, et le SDK réessaie seul.":
    "You can close this page: your calls get “503 enclave_starting” with a Retry-After delay, and the SDK retries on its own.",
  "L’enclave est arrêtée faute d’usage. Elle démarre à la création d’une clé ou à la prochaine prédiction.":
    "The enclave is stopped because it was idle. It starts when you create a key or request the next prediction.",
  "L’enclave s’arrête faute d’usage. Elle redémarrera à la prochaine demande.": "The enclave is stopping because it is idle. It will start again on the next request.",
  "Appels API aujourd’hui (indicatif)": "API calls today (indicative)",
  "Appels achetés (packs réglés)": "Purchased calls (settled packs)",
  "Le compteur qui fait foi est dans l’enclave : chaque réponse de l’API indique le quota du jour et les crédits restants.":
    "The authoritative counter lives in the enclave: every API response reports today's quota and the remaining credits.",
  "Garde cette page ouverte jusqu’à la révocation : tant qu’elle n’est pas confirmée, la clé reste active.":
    "Keep this page open until the revocation completes: until it is confirmed, the key stays active.",
  "Aucune clé API pour ce prêt.": "No API key for this loan.",
  "Créée le {date}": "Created {date}",
  "Dernière utilisation : {date}": "Last used: {date}",
  "Jamais utilisée": "Never used",
  "{count} appels sur 30 jours": "{count} calls in 30 days",
  "Révoquée le {date}": "Revoked {date}",
  "Révocation…": "Revoking…",
  "Confirmer la révocation": "Confirm revocation",
  "Révoquer": "Revoke",
  "{count} clés actives au maximum : révoque une clé pour en créer une autre.": "{count} active keys at most: revoke a key to create another one.",

  // Packs d'appels (BuyCallsPanel, ComputeQuoteDialog)
  "Pack payé : les appels sont crédités dès la confirmation du paiement, même si tu fermes la page.":
    "Pack paid: the calls are credited as soon as the payment is confirmed, even if you close the page.",
  "Devis signé par l’enclave": "Quote signed by the enclave",
  "Acceptation du devis": "Accepting the quote",
  "Paiement dans ton wallet (approbation puis verrouillage)": "Payment in your wallet (approval, then lock)",
  "Confirmation du paiement et crédit des appels": "Payment confirmation and call crediting",
  "Pack de {count} appels en cours": "Pack of {count} calls in progress",
  "Paiement envoyé à l’escrow": "Payment sent to escrow",
  "Confirmation du paiement par le réseau": "Network payment confirmation",
  "Crédit des appels dans l’enclave": "Crediting the calls in the enclave",
  "Tu peux fermer cette page : le paiement est en sécurité dans l’escrow et les appels sont crédités automatiquement.":
    "You can close this page: the payment is safe in escrow and the calls are credited automatically.",
  "Taille du pack": "Pack size",
  "{count} appels": "{count} calls",
  "Prix d’un appel : prix par jour ÷ {calls} appels inclus par jour, arrondi au supérieur. S’ajoutent les frais de calcul de Sirius, à prix coûtant ; le total exact est dans le devis, avant tout paiement. Les appels expirent avec la location et ne sont pas remboursables.":
    "Price per call: daily price ÷ {calls} included calls per day, rounded up. Sirius compute fees are added at cost; the exact total is in the quote, before any payment. Calls expire with the rental and are not refundable.",
  "Garde la page ouverte jusqu’à la signature du paiement ; ensuite, les appels sont crédités même si tu la fermes.":
    "Keep the page open until the payment is signed; after that, the calls are credited even if you close it.",
  "Achat…": "Buying…",
  "Voir le devis et acheter": "See the quote and buy",
  "Acheter des appels": "Buy calls",
  "Devis du pack d’appels": "Call pack quote",
  "Appels achetés": "Calls purchased",
  "Les appels achetés s’ajoutent à cette location, après le quota inclus de chaque jour. Ils expirent avec la location et ne sont pas remboursables.":
    "Purchased calls are added to this rental, after each day's included quota. They expire with the rental and are not refundable.",

  // Page Train : attentes et lignes de pack
  "Pack d’appels": "Call pack",
  "Pack réglé : {count} appels crédités à l’emprunt d’origine.": "Pack settled: {count} calls credited to the original loan.",
  "Autorisation signée par ta session": "Authorization signed by your session",
  "Entraînement dans l’enclave": "Training in the enclave",
  "De quelques secondes à quelques minutes selon la taille du dataset.": "From a few seconds to a few minutes depending on the dataset size.",
  "Règlement on-chain et ouverture des prédictions": "On-chain settlement and opening of predictions",
  "Garde cette page ouverte. Si tu la fermes, reviens finaliser le règlement ici : inutile de payer à nouveau.":
    "Keep this page open. If you close it, come back here to finalize the settlement: no need to pay again.",
  "Paiement verrouillé dans l’escrow": "Payment locked in escrow",
  "Ajout des jours à la location": "Adding the days to the rental",
  "Tu peux fermer cette page : le paiement est en sécurité dans l’escrow et le serveur termine seul.":
    "You can close this page: the payment is safe in escrow and the server finishes on its own.",

  // Runner : clés API, requêtes signées, packs d'appels (src/runner/handler.ts, src/lib/tee/api-keys.ts, ingress, prediction-usage)
  "Identifiant de clé API invalide": "Invalid API key identifier",
  "Signature de requête invalide": "Invalid request signature",
  "Clé API inconnue pour ce modèle": "Unknown API key for this model",
  "Requête expirée : horodatage à plus de 5 minutes de l’horloge de l’enclave":
    "Request expired: timestamp is more than 5 minutes away from the enclave clock",
  "Corps de requête trop volumineux": "Request body is too large",
  "Requête déjà reçue : nonce réutilisé": "Request already received: nonce reused",
  "Corps JSON invalide": "Invalid JSON body",
  "Corps attendu : { \"features\": { … } }": "Expected body: { \"features\": { … } }",
  "Corps de requête inattendu": "Unexpected request body",
  "Pack d’appels invalide": "Invalid call pack",
  "Pack d’appels réservé à l’emprunteur": "Call packs are reserved for the borrower",
  "Pack d’appels hors scope": "Call pack does not match the loan",
  "Location expirée : prolonge avant d’acheter des appels": "Rental expired: extend it before buying calls",
  "Moins d’une heure de location restante : prolonge avant d’acheter des appels":
    "Less than one hour of rental left: extend it before buying calls",
  "Pack d’appels : aucun entraînement": "Call pack: no training",
  "Packs d’appels réservés aux prêts v7": "Call packs are only available for v7 loans",
  "Prêt sans durée de location : packs d’appels impossibles": "Loan without a rental duration: call packs are unavailable",
  "Clé API réservée à l’emprunteur": "API keys are reserved for the borrower",
  "Registre de clés API indisponible": "API key registry is unavailable",
  "Registre de clés API plein": "API key registry is full",
  "Secret de clé API invalide": "Invalid API key secret",
  "Identifiant de clé API déjà utilisé": "API key identifier already in use",
  "Limite de clés API actives atteinte pour ce prêt : révoque une clé d’abord":
    "Active API key limit reached for this loan: revoke a key first",
  "Révocation réservée à l’emprunteur": "Revocation is reserved for the borrower",
  "Enveloppe de clé API manquante": "API key envelope is missing",
  "Enveloppe de clé API incompatible": "Incompatible API key envelope",
  "Enveloppe de clé API invalide": "Invalid API key envelope",
  "Identifiant de pack invalide": "Invalid pack identifier",
  "Taille de pack invalide": "Invalid pack size",
};
