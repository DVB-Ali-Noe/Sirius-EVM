import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { MAX_CHUNKED_DATASET_BYTES } from "@/lib/upload/chunked";
import { priceUsdcToAtomic } from "@/lib/evm/usdc";
import { MODEL_REGISTRY, isModelOffered, modelSelectionForId, type ModelSelection } from "@/lib/models/registry";
import { isValidRentalDays } from "@/lib/billing/rental";
import type { PublishedTariff } from "./tariff";
import {
  ESCROW_CHALLENGE_DAYS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  parseDatasetCategory,
  parseListingDurationDays,
  parseTrainingConsent,
  type DatasetCategory,
  type ListingDurationDays,
} from "./publication";


export interface CreateDatasetRequest {
  name: string;
  description: string | undefined;
  sizeBytes: number;
  /** Prix de location par jour (USDC atomique). */
  priceUsdcAtomic: string;
  /** Durée maximale qu'un emprunteur peut louer, en jours (1–365), signée dans le reçu runner. */
  maxRentalDays: number;
  category: DatasetCategory;
  listingDays: ListingDurationDays;
  trainingConsent: boolean;
  model: ModelSelection;
  /** Toujours `ESCROW_CHALLENGE_DAYS` : la valeur reçue, s'il y en a une, est ignorée. */
  challengeDays: typeof ESCROW_CHALLENGE_DAYS;
  /**
   * `chunked` : gros fichier envoyé en morceaux vers R2 (`/api/datasets/[id]/uploads`, jusqu'à
   * 1 Gio). Absent : l'envoi historique en une seule enveloppe (3 Mio).
   */
  transfer?: "chunked";
}

export type ParsedCreateDatasetRequest =
  | { ok: true; value: CreateDatasetRequest }
  | { ok: false; status: number; error: string };

/** Facturation de l'instance : en v7, un profil facultatif doit figurer dans le tarif publié. */
export interface CreateDatasetBilling {
  v7: boolean;
  tariff: PublishedTariff | null;
}

const UNBILLED: CreateDatasetBilling = { v7: false, tariff: null };

/**
 * Validation serveur du corps de `POST /api/datasets`, sans aucune confiance dans le
 * navigateur : chaque champ est retypé et borné ici, puis `challengeDays` est forcé à la
 * valeur fixée par Sirius quoi qu'ait envoyé le client (01-decisions-avant-samedi.md §3).
 * Les messages d'erreur ne reprennent jamais la valeur reçue.
 *
 * En v7, un profil facultatif sans frais dans le tarif publié est refusé : son dataset ne
 * serait jamais empruntable (le runner refuse le devis). Les profils obligatoires gardent le
 * comportement existant quand le tarif est illisible : toute politique valide les contient.
 */
export function parseCreateDatasetRequest(body: unknown, billing: CreateDatasetBilling = UNBILLED): ParsedCreateDatasetRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "JSON invalide" };
  const input = body as Record<string, unknown>;

  if (typeof input.name !== "string" || input.name.trim() === "" || input.name.trim().length > MAX_NAME_LENGTH) {
    return { ok: false, status: 400, error: "Nom manquant" };
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    return { ok: false, status: 400, error: "Description invalide" };
  }
  if (input.transfer !== undefined && input.transfer !== "chunked") {
    return { ok: false, status: 400, error: "Mode d’envoi invalide" };
  }
  const chunked = input.transfer === "chunked";
  if (
    typeof input.sizeBytes !== "number" ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > (chunked ? MAX_CHUNKED_DATASET_BYTES : MAX_DATASET_BYTES)
  ) {
    return { ok: false, status: 413, error: chunked ? "Fichier vide ou trop volumineux (max 1 Go)" : "Fichier vide ou trop volumineux (max 3 Mo)" };
  }
  const priceUsdcAtomic = priceUsdcToAtomic(input.priceUsdc);
  if (!priceUsdcAtomic) return { ok: false, status: 400, error: "Prix invalide (0.001 à 1 000 000 par jour)" };
  if (!isValidRentalDays(input.maxRentalDays)) {
    return { ok: false, status: 400, error: "Durée maximale de location invalide (1 à 365 jours)" };
  }
  const maxRentalDays = input.maxRentalDays;
  const category = parseDatasetCategory(input.category);
  if (!category) return { ok: false, status: 400, error: "Catégorie obligatoire" };
  const listingDays = parseListingDurationDays(input.listingDays);
  if (!listingDays) return { ok: false, status: 400, error: "Durée de publication invalide (7, 30 ou 90 jours)" };
  const trainingConsent = parseTrainingConsent(input.trainingConsent);
  if (trainingConsent === null) return { ok: false, status: 400, error: "Consentement invalide" };
  const model = modelSelectionForId(input.modelId);
  if (!model || !isModelOffered(model.modelId)) return { ok: false, status: 400, error: "Profil d’entraînement obligatoire" };
  if (billing.v7 && MODEL_REGISTRY[model.modelId].optIn && billing.tariff?.computeFeeAtomic[model.modelId] === undefined) {
    return { ok: false, status: 503, error: "Profil d’entraînement sans tarif de calcul : publication impossible pour l’instant" };
  }

  const description = typeof input.description === "string" ? input.description.trim() : undefined;
  return {
    ok: true,
    value: {
      name: input.name.trim(),
      description: description || undefined,
      sizeBytes: input.sizeBytes,
      priceUsdcAtomic,
      maxRentalDays,
      category,
      listingDays,
      trainingConsent,
      model,
      challengeDays: ESCROW_CHALLENGE_DAYS,
      ...(chunked ? { transfer: "chunked" as const } : {}),
    },
  };
}
