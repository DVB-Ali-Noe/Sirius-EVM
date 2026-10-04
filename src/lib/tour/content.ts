import type { DisclaimerId } from "@/lib/copy/disclaimers";
import type { TourPageKey } from "./keys";

/**
 * Textes des tutos. Comme partout dans le dépôt, les clés sont des phrases françaises
 * traduites à l'affichage par `t()` ; leurs traductions anglaises sont dans
 * `src/lib/i18n/tour-en.ts` (ou déjà dans `english.ts` / `shared-en.ts` pour les titres
 * existants). `tour.test.ts` vérifie qu'aucune clé n'est sans traduction.
 *
 * Les limites des modèles, de la bêta et des données ne sont jamais réécrites ici : elles
 * viennent des textes communs de `src/lib/copy/disclaimers.ts` (identifiants `DisclaimerId`),
 * affichés par `DisclaimerNote` avec le lien vers le contact.
 */

export interface TourStep {
  /** Clé du titre. */
  readonly title: string;
  /** Paragraphes : à quoi sert la page ou l'étape, ce qu'on peut y faire. */
  readonly body: readonly string[];
  /** Limites propres à la page, en liste. */
  readonly limits?: readonly string[];
  /** Textes communs affichés en fin d'étape (qualité des modèles, contact…). */
  readonly disclaimers?: readonly DisclaimerId[];
}

/** Tuto de première connexion (docs/passage-mainnet/04-dashboard.md). */
export const WELCOME_STEPS: readonly TourStep[] = [
  {
    title: "Bienvenue sur Sirius",
    body: [
      "Sirius permet d’entraîner un modèle sur des données confidentielles sans jamais les voir, et de gagner de l’argent en prêtant les vôtres.",
    ],
  },
  {
    title: "Emprunter un dataset",
    body: [
      "Trouvez un dataset sur la Marketplace, payez via un escrow on-chain et lancez l’entraînement. Le calcul tourne dans une enclave sécurisée : vous recevez le modèle entraîné, jamais les données brutes.",
    ],
  },
  {
    title: "Publier un dataset",
    body: [
      "Importez un CSV : il est chiffré dans votre navigateur avant l’envoi. Une fois publié, il peut être emprunté : vous fixez le prix et êtes payé à chaque emprunt réglé.",
    ],
  },
  {
    title: "Votre wallet",
    body: [
      "La page Wallet affiche votre solde et l’ETH disponible pour les frais réseau. Vous pouvez y ajouter des fonds et retirer vers votre wallet les règlements et remboursements crédités dans l’escrow.",
    ],
  },
  {
    title: "Limites de la bêta",
    body: [],
    disclaimers: ["modelQuality", "betaLimits"],
  },
  {
    title: "Besoin de plus ?",
    body: [],
    disclaimers: ["contactUs"],
  },
];

/** Tutos par page (docs/passage-mainnet/02-general.md, section 1). */
export const PAGE_TOURS: Readonly<Record<TourPageKey, TourStep>> = {
  dashboard: {
    title: "Tableau de bord",
    body: [
      "Vue d’ensemble de votre compte : solde et raccourcis vers les autres pages.",
    ],
    disclaimers: ["betaLimits"],
  },
  datasets: {
    title: "Mes datasets",
    body: [
      "Les datasets importés depuis ce wallet et leur état. D’ici, vous pouvez les publier, les gérer ou en importer un nouveau.",
    ],
    limits: ["Seuls les datasets importés depuis ce wallet apparaissent ici."],
  },
  upload: {
    title: "Publier un dataset",
    body: [
      "Importez un CSV, choisissez le modèle d’entraînement et fixez votre prix. Le fichier est chiffré dans votre navigateur avant d’être envoyé à l’enclave sécurisée.",
    ],
    limits: ["Le dataset n’est empruntable qu’une fois publié."],
    disclaimers: ["dataLimits", "modelQuality", "contactUs"],
  },
  marketplace: {
    title: "Marketplace",
    body: [
      "Parcourez les datasets publiés par les fournisseurs. Emprunter un dataset vous permet d’entraîner un modèle dessus sans jamais voir les données brutes.",
    ],
    limits: ["L’emprunt demande un wallet connecté et une attestation KYB valide."],
    disclaimers: ["modelQuality", "contactUs"],
  },
  train: {
    title: "Entraîner un modèle",
    body: [
      "Empruntez un dataset du catalogue, lancez l’entraînement et suivez son avancement. Le calcul tourne dans une enclave sécurisée et vous recevez le modèle entraîné.",
    ],
    limits: ["Un seul entraînement s’exécute à la fois : si le moteur est occupé, réessayez un peu plus tard."],
    disclaimers: ["modelQuality", "retrainDeterministic", "contactUs"],
  },
  explorer: {
    title: "Explorer",
    body: [
      "Vos emprunts, règlements et remboursements, chacun vérifiable sur l’explorateur de la chaîne.",
    ],
    limits: ["L’Explorer montre l’activité on-chain, jamais le contenu des datasets."],
  },
  wallet: {
    title: "Wallet",
    body: [
      "Consultez votre solde et l’ETH disponible pour les frais réseau, ajoutez des fonds et retirez vers votre wallet les règlements et remboursements crédités dans l’escrow.",
    ],
    limits: [
      "Les montants crédités dans l’escrow n’arrivent dans votre wallet qu’une fois retirés.",
      "Les frais réseau sont payés à part, en ETH.",
    ],
  },
};

/** Libellés de la fenêtre et du bouton « ? ». */
export const TOUR_UI = {
  step: "Étape {current} / {total}",
  skip: "Passer",
  previous: "Précédent",
  next: "Suivant",
  finish: "Commencer",
  close: "Compris",
  limits: "Limites",
  welcomeLabel: "Visite guidée",
  pageLabel: "Guide de la page",
  helpButton: "Revoir le guide de cette page",
} as const;

/** Toutes les clés de traduction utilisées par les tutos (pour les tests). */
export function tourTranslationKeys(): string[] {
  const steps = [...WELCOME_STEPS, ...Object.values(PAGE_TOURS)];
  return [
    ...new Set([
      ...steps.flatMap((step) => [step.title, ...step.body, ...(step.limits ?? [])]),
      ...Object.values(TOUR_UI),
    ]),
  ];
}
