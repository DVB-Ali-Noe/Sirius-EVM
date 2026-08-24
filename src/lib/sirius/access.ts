import "server-only";
import { AppError } from "@/lib/errors";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { normalizeAddress } from "@/lib/evm/address";

export async function requireAcceptedKyb(address: string): Promise<void> {
  const valid = await getPublicClient().readContract({
    address: kybRegistryAddress(),
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [normalizeAddress(address)],
  });
  if (!valid) throw new AppError("KYB requis : attestation EVM valide absente", 403);
}
