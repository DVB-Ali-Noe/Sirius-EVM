/**
 * Traductions du guide Sirio (personnage animé du parcours d'accueil). Fichier séparé, fusionné
 * dans `EN_MESSAGES`. `{name}` est le nom du personnage, `{token}` le jeton de règlement du
 * réseau, jamais écrits en dur.
 */
export const GUIDE_MESSAGES_EN: Record<string, string> = {
  // Boutons et libellés
  "Passer le guide": "Skip the guide",
  "C’est parti": "Let’s go",
  "Terminer": "Finish",
  "Réduire le guide": "Minimize the guide",
  "Ouvrir {name}": "Open {name}",
  "Poser une question": "Ask a question",
  "Élément mis en avant par le guide": "Element highlighted by the guide",
  "J’attends que ce soit fait…": "I’ll wait until it’s done…",
  "{name}, le guide Sirius": "{name}, the Sirius guide",

  // Accueil
  "Salut, je suis {name}.": "Hi, I’m {name}.",
  "Sirius permet d’entraîner un modèle sur des données confidentielles sans jamais les voir, et d’être payé quand on prête les siennes.":
    "Sirius lets you train a model on confidential data without ever seeing it, and get paid when you lend yours.",
  "Je te montre comment ça marche en quelques étapes — tu peux passer à tout moment.":
    "I’ll show you how it works in a few steps — you can skip at any time.",

  // Connexion
  "Connecte un wallet": "Connect a wallet",
  "Ton wallet est ton compte Sirius : pas d’e-mail ni de mot de passe. Clique sur Connexion, puis choisis ton wallet.":
    "Your wallet is your Sirius account: no email, no password. Click Connect, then pick your wallet.",
  "Wallet connecté. Maintenant, prouvons qu’il est bien à toi.": "Wallet connected. Now let’s prove it’s yours.",
  "Signe pour te connecter": "Sign to sign in",
  "Clique sur Se connecter : ton wallet te demande de signer un message. C’est gratuit, ce n’est pas une transaction, et ça prouve que ce wallet est bien à toi.":
    "Click Sign in: your wallet asks you to sign a message. It’s free, it’s not a transaction, and it proves you own this wallet.",
  "Bravo, tu es connecté·e !": "Well done, you’re signed in!",

  // Vérification
  "Sur mainnet, chaque prêteur et chaque emprunteur est vérifié on-chain (KYB) : ça protège les données et l’argent de tout le monde.":
    "On mainnet, every lender and borrower is verified on-chain (KYB): it protects everyone’s data and money.",
  "Chaque prêteur et chaque emprunteur est vérifié on-chain (KYB) : ça protège les données et l’argent de tout le monde.":
    "Every lender and borrower is verified on-chain (KYB): it protects everyone’s data and money.",
  "Je regarde si ton wallet est déjà vérifié…": "Checking whether your wallet is already verified…",
  "Une seule transaction à confirmer dans ton wallet, et c’est fait.": "One transaction to confirm in your wallet, and you’re done.",
  "Il te faut un peu d’ETH pour payer le gas de cette transaction : ajoute des fonds d’abord, je t’attends ici.":
    "You need a little ETH to pay the gas for this transaction: add funds first, I’ll wait here.",
  "L’accès instantané n’est pas ouvert : colle le code d’invitation reçu de l’équipe, ou écris-nous.":
    "Instant access is not open: paste the invitation code you received from the team, or write to us.",
  "Je n’arrive pas à lire ton statut pour l’instant. Tu peux le vérifier sur la page KYB, ou continuer.":
    "I can’t read your status right now. You can check it on the KYB page, or continue.",
  "Ton wallet est vérifié. Je te fais visiter ?": "Your wallet is verified. Shall I show you around?",

  // Tour du menu (« Phala » est un nom propre, identique dans les deux langues)
  "Phala": "Phala",
  "Parcours les datasets publiés, et emprunte celui qu’il te faut : le prix est bloqué en escrow, jamais versé d’avance.":
    "Browse the published datasets and borrow the one you need: the price is locked in escrow, never paid upfront.",
  "Lance tes entraînements et récupère tes modèles ici. Après le paiement, compte ~15 minutes de finalité avant de lancer le job.":
    "Run your training jobs and collect your models here. After payment, allow ~15 minutes of finality before running the job.",
  "Dépose un CSV : il est chiffré dans ton navigateur, et tu es payé·e en {token} à chaque entraînement réglé.":
    "Upload a CSV: it is encrypted in your browser, and you get paid in {token} on every settled training run.",
  "Tes emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne.":
    "Your borrowings, settlements and refunds, each verifiable on the chain explorer.",
  "L’enclave qui entraîne sans voir les données : son identité est attestée à chaque requête.":
    "The enclave that trains without seeing the data: its identity is attested on every request.",
  "Ton solde, ta liste « Bien démarrer » et tes raccourcis. On y revient quand tu veux.":
    "Your balance, your “Get started” list and your shortcuts. Come back whenever you like.",
  "Tu sais tout !": "You know it all!",
  "Je reste dans ma bulle en bas à droite : clique dessus pour me poser une question ou revoir la visite.":
    "I’ll stay in my bubble at the bottom right: click it to ask me a question or replay the tour.",
};
