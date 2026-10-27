import "server-only";
import { AppError } from "@/lib/app-error";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { addressesEqual } from "./address";
import { datasetRegistryAddress, escrowAddress } from "./addresses";
import { getPublicClient } from "./client";
import { billingEnabled } from "@/lib/billing/config";
import { resolveServerNetwork } from "./networks";
import { MODEL_REGISTRY, isModelOffered, selectionForModelId, trainingProfileHash, type ModelId } from "@/lib/models/registry";

/** v5 garde l'interface de v4 et ajoute la liste de profils extensible par l'administrateur. */
const DATASET_VERSIONS = ["sirius-dataset-v4", "sirius-dataset-v5"];
const CACHE_MS = 60_000;
let verifiedAt = 0;
let verifiedKey = "";
let verification: { key: string; promise: Promise<void> } | null = null;

/** Profils proposés à cet instant : ceux que le registre doit accepter pour que le mint réussisse. */
function offeredModelIds(): ModelId[] {
  return (Object.keys(MODEL_REGISTRY) as ModelId[]).filter((id) => isModelOffered(id));
}

async function verifyDeployment(allowPreviousEscrow = false): Promise<void> {
  const client = getPublicClient();
  const escrow = escrowAddress();
  const datasets = datasetRegistryAddress();
  try {
    const [escrowVersion, datasetVersion, linkedDatasets, linkedEscrow] = await Promise.all([
      client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "VERSION" }),
      client.readContract({ address: datasets, abi: siriusdatasetregistryAbi, functionName: "VERSION" }),
      client.readContract({ address: escrow, abi: siriusescrowAbi, functionName: "datasets" }),
      client.readContract({ address: datasets, abi: siriusdatasetregistryAbi, functionName: "escrow" }),
    ]);
    if (
      (escrowVersion !== (billingEnabled() ? "sirius-escrow-usdc-v7" : "sirius-escrow-usdc-v6")
        && !(allowPreviousEscrow && ["sirius-escrow-usdc-v5", "sirius-escrow-usdc-v6", "sirius-escrow-usdc-v7"].includes(escrowVersion))) ||
      !DATASET_VERSIONS.includes(datasetVersion) ||
      !addressesEqual(linkedDatasets, datasets) ||
      !addressesEqual(linkedEscrow, escrow)
    ) {
      throw new AppError(allowPreviousEscrow
        ? "Contrats du reaper incompatibles : escrow v5, v6 ou v7 et registre dataset v4 ou v5 lié requis"
        : "Contrats EVM incompatibles avec la version de facturation configurée", 503);
    }
    // Nouveaux prêts et publications : chaque profil proposé doit être accepté au mint, sinon le
    // fichier serait scellé avant un échec on-chain. Le reaper ne publie rien et n'en dépend pas.
    if (!allowPreviousEscrow) {
      const supported = await Promise.all(offeredModelIds().map((id) => client.readContract({
        address: datasets, abi: siriusdatasetregistryAbi, functionName: "isSupportedTrainingProfile",
        args: [trainingProfileHash(selectionForModelId(id))],
      })));
      if (!supported.every(Boolean)) throw new AppError("Registre dataset : un profil d’entraînement proposé n’est pas accepté on-chain", 503);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Contrats EVM Sirius indisponibles ou incompatibles", 503);
  }
}

// La réconciliation reste disponible pendant la migration ; ce contrôle ne valide
// pas le cache utilisé pour autoriser de nouveaux prêts.
export function requireReaperEvmDeployment(): Promise<void> {
  return verifyDeployment(true);
}

export function requireCurrentEvmDeployment(): Promise<void> {
  const { chain, rpcUrl } = resolveServerNetwork();
  const key = JSON.stringify([chain.id, rpcUrl, escrowAddress(), datasetRegistryAddress(), billingEnabled(), offeredModelIds()]);
  if (key === verifiedKey && Date.now() - verifiedAt < CACHE_MS) return Promise.resolve();
  if (verification?.key !== key) {
    const promise = verifyDeployment()
      .then(() => {
        verifiedAt = Date.now();
        verifiedKey = key;
      })
      .finally(() => {
        if (verification?.key === key) verification = null;
      });
    verification = { key, promise };
  }
  return verification.promise;
}
