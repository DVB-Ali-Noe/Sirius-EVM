/**
 * Traductions des tutos (slice A3) : tuto de première connexion, tutos par page et bouton
 * « ? ». Fichier séparé, fusionné dans `EN_MESSAGES`, pour ne pas entrer en conflit avec
 * les autres slices qui complètent `english.ts`.
 *
 * Les titres déjà traduits ailleurs (« Bienvenue sur Sirius », « Tableau de bord »,
 * « Mes datasets », « Publier un dataset », « Entraîner un modèle », « Explorer ») et les
 * boutons de l'ancien tuto (« Passer », « Suivant »…) ne sont pas redéfinis ici. Les
 * limites des modèles et de la bêta viennent de `shared-en.ts` (textes communs).
 */
export const TOUR_MESSAGES_EN: Record<string, string> = {
  // Tuto de première connexion
  "Sirius permet d’entraîner un modèle sur des données confidentielles sans jamais les voir, et de gagner de l’argent en prêtant les vôtres.":
    "Sirius lets you train a model on confidential data without ever seeing it, and earn money by lending your own data.",
  "Emprunter un dataset": "Borrow a dataset",
  "Trouvez un dataset sur la Marketplace, payez via un escrow on-chain et lancez l’entraînement. Le calcul tourne dans une enclave sécurisée : vous recevez le modèle entraîné, jamais les données brutes.":
    "Find a dataset on the Marketplace, pay through an on-chain escrow and launch training. The computation runs in a secure enclave: you receive the trained model, never the raw data.",
  "Importez un CSV : il est chiffré dans votre navigateur avant l’envoi. Une fois publié, il peut être emprunté : vous fixez le prix et êtes payé à chaque emprunt réglé.":
    "Upload a CSV: it is encrypted in your browser before it is sent. Once published, it can be borrowed: you set the price and get paid for each settled loan.",
  "Votre wallet": "Your wallet",
  "La page Wallet affiche votre solde et l’ETH disponible pour les frais réseau. Vous pouvez y ajouter des fonds et retirer vers votre wallet les règlements et remboursements crédités dans l’escrow.":
    "The Wallet page shows your balance and the ETH available for network fees. You can add funds there and withdraw the settlements and refunds credited to you in the escrow to your wallet.",
  "Limites de la bêta": "Beta limits",
  "Besoin de plus ?": "Need more?",

  // Tutos par page
  "Vue d’ensemble de votre compte : solde et raccourcis vers les autres pages.":
    "An overview of your account: balance and shortcuts to the other pages.",
  "Les datasets importés depuis ce wallet et leur état. D’ici, vous pouvez les publier, les gérer ou en importer un nouveau.":
    "The datasets uploaded from this wallet and their status. From here you can publish them, manage them or upload a new one.",
  "Seuls les datasets importés depuis ce wallet apparaissent ici.": "Only datasets uploaded from this wallet appear here.",
  "Importez un CSV, choisissez le modèle d’entraînement et fixez votre prix. Le fichier est chiffré dans votre navigateur avant d’être envoyé à l’enclave sécurisée.":
    "Upload a CSV, choose the training model and set your price. The file is encrypted in your browser before it is sent to the secure enclave.",
  "Le dataset n’est empruntable qu’une fois publié.": "The dataset can only be borrowed once it is published.",
  "Marketplace": "Marketplace",
  "Parcourez les datasets publiés par les fournisseurs. Emprunter un dataset vous permet d’entraîner un modèle dessus sans jamais voir les données brutes.":
    "Browse datasets published by providers. Borrowing a dataset lets you train a model on it without ever seeing the raw data.",
  "L’emprunt demande un wallet connecté et une attestation KYB valide.": "Borrowing requires a connected wallet and a valid KYB attestation.",
  "Empruntez un dataset du catalogue, lancez l’entraînement et suivez son avancement. Le calcul tourne dans une enclave sécurisée et vous recevez le modèle entraîné.":
    "Borrow a dataset from the catalog, launch training and follow its progress. The computation runs in a secure enclave and you receive the trained model.",
  "Un seul entraînement s’exécute à la fois : si le moteur est occupé, réessayez un peu plus tard.": "One training runs at a time: if the engine is busy, try again a little later.",
  "Vos emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne.":
    "Your borrowings, settlements and refunds, each verifiable on the chain explorer.",
  "L’Explorer montre l’activité on-chain, jamais le contenu des datasets.": "The Explorer shows on-chain activity, never the contents of datasets.",
  "Wallet": "Wallet",
  "Consultez votre solde et l’ETH disponible pour les frais réseau, ajoutez des fonds et retirez vers votre wallet les règlements et remboursements crédités dans l’escrow.":
    "Check your balance and the ETH available for network fees, add funds, and withdraw the settlements and refunds credited to you in the escrow to your wallet.",
  "Les montants crédités dans l’escrow n’arrivent dans votre wallet qu’une fois retirés.": "Amounts credited in the escrow only reach your wallet once you withdraw them.",
  "Les frais réseau sont payés à part, en ETH.": "Network fees are paid separately, in ETH.",

  // Fenêtre et bouton « ? »
  "Compris": "Got it",
  "Limites": "Limits",
  "Visite guidée": "Guided tour",
  "Guide de la page": "Page guide",
  "Revoir le guide de cette page": "Show this page's guide",
};
