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
  "Démarrage de l’enclave sécurisée — environ 2 minutes": "Starting the secure enclave — about 2 minutes",
  "Vos données ne sont traitées que dans une machine confidentielle (TEE Intel TDX). Pour limiter les coûts, elle n’est allumée que lorsqu’on en a besoin : elle démarre, puis prouve son identité (attestation) avant de recevoir quoi que ce soit. Rien n’est payé ni envoyé pendant l’attente ; l’opération reprend toute seule.":
    "Your data is only processed inside a confidential machine (Intel TDX TEE). To keep costs down, it only runs when needed: it boots, then proves its identity (attestation) before receiving anything. Nothing is paid or sent while you wait; the operation resumes on its own.",
  "Plus long que d’habitude : le démarrage peut prendre jusqu’à 5 minutes. Garde cette page ouverte.":
    "Taking longer than usual: the start can take up to 5 minutes. Keep this page open.",
  "Démarrage demandé": "Start requested",
  "Démarrage de la machine confidentielle (≈ 1 min 30)": "Booting the confidential machine (≈ 1 min 30 s)",
  "Vérification de l’attestation, puis reprise automatique (≈ 30 s)": "Attestation check, then automatic resume (≈ 30 s)",
  "Attente : {minutes} min {seconds} s": "Waiting: {minutes} min {seconds} s",
  "Attente : {seconds} s": "Waiting: {seconds} s",
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
  "Appelle ce modèle depuis ton code avec une clé signée, pendant les jours d’accès API payés. Le quota de {calls} appels par jour est commun au site et à l’API ; les appels achetés prennent le relais une fois le quota du jour épuisé.":
    "Call this model from your code with a signed key, during the paid API access days. The quota of {calls} calls per day is shared by the site and the API; purchased calls take over once the day's quota is used up.",
  "Tu peux fermer cette page : tes appels reçoivent « 503 enclave_starting » avec un délai Retry-After, et le SDK réessaie seul.":
    "You can close this page: your calls get “503 enclave_starting” with a Retry-After delay, and the SDK retries on its own.",
  "L’enclave est arrêtée faute d’usage. Elle démarre à la création d’une clé ou à la prochaine prédiction.":
    "The enclave is stopped because it was idle. It starts when you create a key or request the next prediction.",
  "L’enclave est arrêtée faute d’usage. Le premier appel API la redémarre : il reçoit « 503 enclave_starting » avec un délai Retry-After (environ 2 min), et le SDK réessaie seul.":
    "The enclave is stopped because it was idle. The first API call starts it again: it gets “503 enclave_starting” with a Retry-After delay (about 2 min), and the SDK retries on its own.",
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
  "En général quelques secondes": "Usually a few seconds",
  "Garde cette page ouverte : l’activation se termine ici dès la confirmation du réseau.":
    "Keep this page open: activation completes here as soon as the network confirms.",
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
  "Accès API": "API access",
  "Accès API réglé : {days} payés à l’emprunt d’origine.": "API access settled: {days} paid on the original loan.",
  "Achat d’accès API invalide": "Invalid API access purchase",
  "Devis de l’accès API": "API access quote",
  "Jours d’accès API": "API access days",
  "La prolongation ne comprend pas l’accès API : si tu utilises l’API, elle s’arrêtera à sa date payée actuelle et les jours ajoutés se paient ensuite depuis le panneau API.":
    "The extension does not include API access: if you use the API, it will stop at its current paid date, and the added days are paid afterwards from the API panel.",
  "L’accès API est payé par jour à Sirius, jusqu’à la fin de la location ; le fournisseur reçoit la part minimale de 0,001. Une prolongation d’une location ainsi couverte jusqu’à son échéance inclut l’API d’office pour les jours ajoutés. Non remboursable une fois activé.":
    "API access is paid per day to Sirius, until the end of the rental; the provider receives the minimum share of 0.001. Extending a rental covered this way up to its end automatically includes the API for the added days. Non-refundable once activated.",
  "API non activée": "API not activated",
  "API payée jusqu’au {date}": "API paid until {date}",
  "Accès API en cours d’activation": "API access being activated",
  "Accès API payé : il s’active dès la confirmation du paiement, même si tu fermes la page.":
    "API access paid: it activates as soon as the payment is confirmed, even if you close the page.",
  "Accès API terminé le {date}": "API access ended on {date}",
  "Activation de l’accès API dans l’enclave": "Activating API access in the enclave",
  "Activer l’API — {amount} pour {days}": "Activate the API — {amount} for {days}",
  "Garde la page ouverte jusqu’à la signature du paiement ; ensuite, l’accès API s’active même si tu la fermes.":
    "Keep the page open until the payment is signed; after that, API access activates even if you close it.",
  "La location a été prolongée : l’API s’arrête le {date}. Paie les jours ajoutés pour la garder active jusqu’au {end}.":
    "The rental was extended: the API stops on {date}. Pay for the added days to keep it active until {end}.",
  "L’API est payée par jour : {fee} par jour jusqu’à la fin de la location, plus 0,001 au fournisseur. Les prédictions depuis le site restent incluses.":
    "The API is paid per day: {fee} per day until the end of the rental, plus 0.001 to the provider. Predictions from the site remain included.",
  "L’accès API n’est pas en vente pour le moment : sans pass payé, aucune clé ne peut être créée et l’API refuse les appels.":
    "API access is not for sale at the moment: without a paid pass, no key can be created and the API refuses calls.",
  "Moins d’une heure de location restante : prolonge avant d’activer l’API": "Less than an hour of rental left: extend before activating the API",
  "Prolonger l’API — {amount} pour {days}": "Extend the API — {amount} for {days}",
  "Tu peux fermer cette page : le paiement est en sécurité dans l’escrow et l’accès API s’active automatiquement.":
    "You can close this page: the payment is safe in the escrow and API access activates automatically.",
  "Active l’API pour créer une clé.": "Activate the API to create a key.",
  "Nombre de jours d'accès API invalide.": "Invalid number of API access days.",
  "Précision du jeton invalide.": "Invalid token precision.",
  "Nombre de jours d’accès API invalide": "Invalid number of API access days",
  "Couverture d’accès API invalide": "Invalid API access coverage",
  "Identifiant de pass invalide": "Invalid pass identifier",
  "Pass d’accès API hors scope": "API access pass does not match the loan",
  "Pass d’accès API invalide": "Invalid API access pass",
  "Accès API non payé pour cette période : active l’API (pass journalier) depuis la page Entraîner":
    "API access not paid for this period: activate the API (daily pass) from the Train page",
  "Accès API non proposé par le tarif en vigueur : aucun pass n’est en vente pour le moment":
    "API access is not offered by the current tariff: no pass is for sale at the moment",
  "Accès API déjà payé jusqu’à l’échéance de la location": "API access already paid until the end of the rental",
  "Un pass d’accès API est déjà en cours de paiement : il s’active dès la confirmation du réseau":
    "An API access pass is already being paid: it activates as soon as the network confirms it",
  "Accès API payé : il s’active dès la confirmation du réseau, sans autre action de ta part":
    "API access paid: it activates as soon as the network confirms it, with no further action from you",
  "Préparation de l’accès API échouée": "API access preparation failed",
  "Activation de l’accès API échouée": "API access activation failed",
  "Profil d’entraînement du dataset modifié : achat d’accès API impossible": "The dataset’s training profile changed: API access purchase impossible",
  "Achat d’accès API indisponible sans devis compute": "API access purchase unavailable without a compute quote",
  "Accès API refusé : rien n’a été versé, paiement remboursable le {date}.": "API access refused: nothing was paid out, payment refundable on {date}.",
  "Accès API refusé : rien n’a été versé, paiement remboursable à l’échéance de l’escrow.":
    "API access refused: nothing was paid out, payment refundable at the escrow deadline.",
  "Pass d’accès API refusé (couverture ou échéance changée depuis son devis) : rien n’a été versé, remboursable le {date}.":
    "API access pass refused (coverage or rental end changed since its quote): nothing was paid out, refundable on {date}.",
  "Pass d’accès API refusé (couverture ou échéance changée depuis son devis) : rien n’a été versé, remboursable à l’échéance de l’escrow.":
    "API access pass refused (coverage or rental end changed since its quote): nothing was paid out, refundable at the escrow deadline.",
  "Un pass d’accès API est déjà en préparation : termine ou abandonne son paiement, puis réessaie dans quelques minutes":
    "An API access pass is already being prepared: finish or abandon its payment, then try again in a few minutes",
  "Pass d’accès API caduc : la couverture payée a changé depuis son devis ou un autre pass est en cours de règlement ; rien n’est versé, le paiement est remboursable à l’échéance de l’escrow":
    "API access pass no longer valid: the paid coverage changed since its quote or another pass is being settled; nothing is paid out, the payment is refundable at the escrow deadline",
  "Appelle le modèle depuis ton code pendant toute la location, payé avec l’emprunt ; les prolongations le gardent. Sans cette option, l’API reste activable plus tard depuis la page Entraîner.":
    "Call the model from your code for the whole rental, paid with the loan; extensions keep it. Without this option, the API can still be activated later from the Train page.",
  "Inclure l’accès API (+{fee} par jour)": "Include API access (+{fee} per day)",
  "Accès API inclus du devis invalide": "Invalid included API access in the quote",
  "Accès API inclus (1 jour)": "API access included (1 day)",
  "Accès API inclus ({days} jours)": "API access included ({days} days)",
  "L’accès API est payé avec l’emprunt pour toute la location ; une prolongation le prolonge aussi. En cas d’échec de l’entraînement, il est remboursé avec le reste, hors frais d’exécution mesurés.":
    "API access is paid with the loan for the whole rental; an extension extends it too. If training fails, it is refunded with the rest, except the measured execution fees.",
  "Ta location a l’accès API jusqu’à son échéance : la prolongation l’inclut pour les jours ajoutés, au tarif journalier de l’API.":
    "Your rental has API access until its end: the extension includes it for the added days, at the API daily rate.",
  "API incluse, payée jusqu’au {date}": "API included, paid until {date}",
};
