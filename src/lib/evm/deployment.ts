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

async function verifyDeployment(): Promise<void> {
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
      escrowVersion !== ESCROW_VERSION ||
      datasetVersion !== DATASET_VERSION ||
      !addressesEqual(linkedDatasets, datasets) ||
      !addressesEqual(linkedEscrow, escrow)
    ) {
      throw new AppError("Contrats EVM incompatibles : déploie SiriusEscrow v6 et un SiriusDatasetRegistry v4 associé", 503);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Contrats EVM Sirius indisponibles ou incompatibles", 503);
  }
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
