/**
 * Traductions de l'assistant Sirio : erreurs de la route `/api/assistant/chat` et interface du
 * panneau de chat. Fichier séparé, fusionné dans `EN_MESSAGES`.
 */
export const ASSISTANT_MESSAGES_EN: Record<string, string> = {
  // Démarrage
  "SIRIUS_ASSISTANT_ENABLED doit valoir true ou false": "SIRIUS_ASSISTANT_ENABLED must be true or false",
  "SIRIUS_ASSISTANT_ENABLED=true exige ANTHROPIC_API_KEY": "SIRIUS_ASSISTANT_ENABLED=true requires ANTHROPIC_API_KEY",
  "SIRIUS_ASSISTANT_ENABLED=true exige SIRIUS_ASSISTANT_SECRET : 32 caractères au moins": "SIRIUS_ASSISTANT_ENABLED=true requires SIRIUS_ASSISTANT_SECRET: at least 32 characters",
  "Trop de questions aujourd’hui depuis ce poste — réessaie demain": "Too many questions today from this device — try again tomorrow",

  // Route
  "Assistant indisponible": "Assistant unavailable",
  "Requête d’assistant invalide": "Invalid assistant request",
  "Message trop long": "Message too long",
  "Historique trop long": "Conversation too long",
  "Assistant indisponible aujourd’hui : plafond quotidien atteint": "Assistant unavailable today: daily limit reached",
  "Assistant très sollicité — réessaie dans un instant": "The assistant is busy — try again in a moment",
  "Assistant injoignable — réessaie plus tard": "The assistant cannot be reached — try again later",
  "Assistant momentanément indisponible — réessaie plus tard": "The assistant is temporarily unavailable — try again later",
  "Assistant indisponible pour le moment": "The assistant is unavailable right now",

  // Panneau de chat
  "Pose ta question sur Sirius": "Ask anything about Sirius",
  "Comment emprunter un dataset ?": "How do I borrow a dataset?",
  "Pourquoi attendre ~15 minutes ?": "Why wait ~15 minutes?",
  "Comment publier des données ?": "How do I publish data?",
  "Mes données sont-elles en sécurité ?": "Is my data safe?",
  "Écris ta question…": "Type your question…",
  "Envoyer la question": "Send question",
  "Sirio réfléchit…": "Sirio is thinking…",
  "Sirio ne peut pas répondre à cette demande. Pose une question sur Sirius, ou écris à l’équipe.":
    "Sirio can’t answer that request. Ask something about Sirius, or write to the team.",
  "Réponse coupée : pose une question plus précise.": "Answer cut short: ask a more specific question.",
  "Connexion perdue — réessaie.": "Connection lost — try again.",
  "Contacter l’équipe": "Contact the team",
  "Effacer la conversation": "Clear the conversation",
  "Réessayer": "Retry",
  "Sirio répond aux questions sur Sirius et l’utilisation du site. Il ne donne aucun conseil financier et ne demande jamais de clé privée.":
    "Sirio answers questions about Sirius and how to use the site. It gives no financial advice and never asks for a private key.",
  "Le chat n’est pas activé sur cette instance. Voici les réponses les plus demandées :":
    "Chat is not enabled on this instance. Here are the most common answers:",
  "Ouvre la Marketplace, choisis un dataset et clique sur Emprunter : le prix et le compute sont bloqués en escrow, puis l’entraînement tourne dans un TEE.":
    "Open the Marketplace, pick a dataset and click Borrow: the price and compute are locked in escrow, then training runs in a TEE.",
  "Après le paiement, la chaîne doit atteindre la finalité (~15 min) avant que le job puisse démarrer. Laisse la page Entraîner ouverte ou reviens cliquer sur Lancer le job.":
    "After payment, the chain must reach finality (~15 min) before the job can start. Keep the Train page open or come back and click Run job.",
  "Dans Mes datasets, importe un CSV : il est chiffré dans ton navigateur, puis publie son titre on-chain pour le rendre empruntable.":
    "In My datasets, upload a CSV: it is encrypted in your browser, then publish its on-chain title to make it borrowable.",
  "Les données brutes ne quittent jamais le chiffrement : l’entraînement tourne dans une enclave et l’emprunteur ne reçoit que le modèle.":
    "Raw data never leaves encryption: training runs inside an enclave and the borrower only receives the model.",
  "Conversation avec Sirio": "Conversation with Sirio",
  "Fermer le panneau": "Close panel",
  "Revoir la visite guidée": "Replay the guided tour",
};
