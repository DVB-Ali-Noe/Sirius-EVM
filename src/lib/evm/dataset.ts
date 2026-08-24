import "server-only";
import type { Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { normalizeAddress } from "./address";
import { datasetRegistryAddress } from "./addresses";
import { siriusdatasetregistryAbi } from "./abi/siriusdatasetregistry";
import { getPublicClient } from "./client";
import { cidHash, datasetIdHash } from "./dataset-key";

export async function assertDatasetScope(input: {
  datasetId: string;
  provider: string;
  merkleRoot: string;
  cid: string;
}): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.merkleRoot)) {
    throw new AppError("Racine Merkle EVM invalide", 409);
  }
  const provider = normalizeAddress(input.provider);
  const client = getPublicClient();
  const registry = datasetRegistryAddress();
  const onChainId = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "datasetIdOf",
    args: [provider, datasetIdHash(input.datasetId)],
  });
  const matches = await client.readContract({
    address: registry,
    abi: siriusdatasetregistryAbi,
    functionName: "matchesScope",
    args: [onChainId, provider, input.merkleRoot as Hex, cidHash(input.cid)],
  });
  if (!matches) throw new AppError("Titre EVM du dataset inactif ou hors scope", 409);
}
