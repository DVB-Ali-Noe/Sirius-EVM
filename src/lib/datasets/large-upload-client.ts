"use client";

import { messageOf } from "@/lib/errors-client";
import { verifyIngressKey } from "@/lib/tee/ingress-client";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { blobSource, sendChunkedDataset } from "@/lib/upload/chunked-transfer";
import { publishDataset } from "./client";
import { checkDraftResponse } from "./draft-response";
import { responseError, retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { UploadError, type UploadInput, type UploadOptions, type UploadProgress, type UploadStep } from "./upload-client";

/** Gros fichier : le `File` du navigateur, lu par tranches, jamais chargé en entier. */
export interface LargeUploadInput extends Omit<UploadInput, "content"> {
  file: Blob;
}

export interface LargeUploadProgress extends UploadProgress {
  /** Part du fichier chiffrée et envoyée, de 0 à 1, pendant l'étape `encrypt`. */
  sent?: number;
}

/**
 * Publication d'un gros dataset (jusqu'à 1 Go, docs/UPLOAD-1GO.md) : mêmes étapes que
 * `uploadAndPublishDataset`, mais le fichier part en morceaux chiffrés directement vers le
 * stockage, puis l'enclave les relit et les scelle. Le brouillon, le grant et l'inscription
 * on-chain restent ceux du parcours habituel. Enclave à l'arrêt : le brouillon, l'ouverture et la
 * clôture de l'envoi attendent son démarrage (`onEnclaveWaiting`), sans perdre les morceaux envoyés.
 */
export async function uploadAndPublishLargeDataset(
  input: LargeUploadInput,
  onProgress: (progress: LargeUploadProgress) => void,
  { signal, onEnclaveWaiting }: UploadOptions & { signal?: AbortSignal } = {},
): Promise<{ datasetId: string }> {
  let step: UploadStep = "draft";
  let sealedDatasetId: string | null = null;
  try {
    onProgress({ step });
    const initBody = await retryWhileEnclaveStarts(async () => {
      const initRes = await fetch("/api/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          description: input.description || undefined,
          sizeBytes: input.sizeBytes,
          priceUsdc: input.priceUsdc,
          category: input.category,
          maxRentalDays: input.maxRentalDays,
          listingDays: input.listingDays,
          trainingConsent: input.trainingConsent,
          modelId: input.modelId,
          transfer: "chunked",
        }),
      });
      if (!initRes.ok) throw await responseError(initRes, "Échec de la préparation du dépôt");
      return (await initRes.json().catch(() => ({}))) as unknown;
    }, { onWaiting: onEnclaveWaiting });
    const draft = checkDraftResponse(initBody, {
      priceUsdcAtomic: input.priceUsdcAtomic,
      sizeBytes: input.sizeBytes,
      modelId: input.modelId,
      category: input.category,
      maxRentalDays: input.maxRentalDays,
      listingDays: input.listingDays,
      trainingConsent: input.trainingConsent,
    });

    step = "encrypt";
    onProgress({ step, sent: 0 });
    await sendChunkedDataset(
      {
        datasetId: draft.datasetId,
        priceUsdcAtomic: draft.priceUsdcAtomic,
        challengeDays: draft.challengeDays,
        maxRentalDays: draft.maxRentalDays,
        sizeBytes: draft.sizeBytes,
        model: draft.model,
      },
      blobSource(input.file),
      {
        api: {
          request: (path, init) => fetch(path, init),
          put: (url, body, abort) => fetch(url, { method: "PUT", body, signal: abort }),
        },
        verifyIngressKey,
        issueGrant: (datasetId, intentParts) => issueRunnerGrant("seal-chunked-dataset", { datasetId }, intentParts),
        onProgress: (progress) => {
          if (progress.phase === "upload") {
            onProgress({ step: "encrypt", sent: progress.totalBytes ? progress.sentBytes / progress.totalBytes : 0 });
          } else {
            step = "seal";
            onProgress({ step });
          }
        },
        signal,
        onEnclaveWaiting,
      },
    );
    sealedDatasetId = draft.datasetId;

    step = "register";
    onProgress({ step });
    await publishDataset(draft.datasetId, (stage) => onProgress({ step: "register", stage }));
    return { datasetId: draft.datasetId };
  } catch (error) {
    throw new UploadError(messageOf(error), step, sealedDatasetId);
  }
}
