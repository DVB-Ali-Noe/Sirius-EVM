import "server-only";
import { AppError } from "@/lib/app-error";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { addressesEqual } from "./address";
import { datasetRegistryAddress, escrowAddress } from "./addresses";
import { getPublicClient } from "./client";

const ESCROW_VERSION = "sirius-escrow-usdc-v6";
const DATASET_VERSION = "sirius-dataset-v4";
const CACHE_MS = 60_000;
let verifiedAt = 0;
let verification: Promise<void> | null = null;

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
      (escrowVersion !== ESCROW_VERSION && !(allowPreviousEscrow && escrowVersion === "sirius-escrow-usdc-v5")) ||
      datasetVersion !== DATASET_VERSION ||
      !addressesEqual(linkedDatasets, datasets) ||
      !addressesEqual(linkedEscrow, escrow)
    ) {
      throw new AppError(allowPreviousEscrow
        ? "Contrats du reaper incompatibles : escrow v5 ou v6 et registre dataset v4 lié requis"
        : "Contrats EVM incompatibles : déploie SiriusEscrow v6 et un SiriusDatasetRegistry v4 associé", 503);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Contrats EVM Sirius indisponibles ou incompatibles", 503);
  }
}

// La réconciliation reste disponible pendant la migration ; ce contrôle ne valide
// pas le cache utilisé pour autoriser de nouveaux prêts v6.
export function requireReaperEvmDeployment(): Promise<void> {
  return verifyDeployment(true);
}

export function requireCurrentEvmDeployment(): Promise<void> {
  if (Date.now() - verifiedAt < CACHE_MS) return Promise.resolve();
  if (!verification) {
    verification = verifyDeployment()
      .then(() => {
        verifiedAt = Date.now();
      })
      .finally(() => {
        verification = null;
      });
  }
  return verification;
}
