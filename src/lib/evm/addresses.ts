import { getAddress, type Address } from "viem";

function configured(publicName: string, privateName?: string): Address {
  const value = process.env[privateName ?? publicName]?.trim() || process.env[publicName]?.trim();
  if (!value) throw new Error(`${privateName ?? publicName} ou ${publicName} manquante`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${privateName ?? publicName} n'est pas une adresse EVM valide`);
  }
}

export function escrowAddress(): Address {
  return configured("NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS", "SIRIUS_ESCROW_ADDRESS");
}

export function usdcAddress(): Address {
  return configured("NEXT_PUBLIC_SIRIUS_USDC_ADDRESS", "SIRIUS_USDC_ADDRESS");
}

export function kybRegistryAddress(): Address {
  return configured("NEXT_PUBLIC_SIRIUS_KYB_ADDRESS", "SIRIUS_KYB_ADDRESS");
}

export function datasetRegistryAddress(): Address {
  return configured("NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS", "SIRIUS_DATASET_ADDRESS");
}
